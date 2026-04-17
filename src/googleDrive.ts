const GOOGLE_GIS_SCRIPT = 'https://accounts.google.com/gsi/client'
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'

type GoogleTokenResponse = {
  access_token?: string
  expires_in?: number | string
  error?: string
  error_description?: string
}

type GoogleTokenClient = {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void
}

type DriveFileMetadata = {
  id: string
  name?: string
  webContentLink?: string
  webViewLink?: string
  resourceKey?: string
  mimeType?: string
}

type DrivePermissionResponse = {
  id?: string
}

type DriveSession = {
  accessToken: string
  expiresAt: number
}

export type DriveUploadResult = {
  fileId: string
  publicUrl: string
  webViewLink: string
  name: string
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string
            scope: string
            callback: (response: GoogleTokenResponse) => void
            error_callback?: (error: { type?: string }) => void
          }) => GoogleTokenClient
          revoke?: (token: string, callback?: () => void) => void
        }
      }
    }
  }
}

let gisScriptPromise: Promise<void> | null = null
let driveSession: DriveSession | null = null

function loadGoogleIdentityScript(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google auth yalniz brauzerde isleyir.'))
  }

  if (window.google?.accounts?.oauth2) {
    return Promise.resolve()
  }

  if (gisScriptPromise) {
    return gisScriptPromise
  }

  gisScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_GIS_SCRIPT}"]`,
    )

    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Google GIS script yuklenmedi.')), {
        once: true,
      })
      return
    }

    const script = document.createElement('script')
    script.src = GOOGLE_GIS_SCRIPT
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Google GIS script yuklenmedi.'))
    document.head.appendChild(script)
  }).catch((error) => {
    gisScriptPromise = null
    throw error
  })

  return gisScriptPromise
}

function ensureClientId(clientId: string): string {
  const trimmed = clientId.trim()
  if (!trimmed) {
    throw new Error('Google Drive client id tapilmadi. `.env.local` faylina elave edin.')
  }
  return trimmed
}

async function requestDriveToken(clientId: string, prompt: string): Promise<DriveSession> {
  const normalizedClientId = ensureClientId(clientId)
  await loadGoogleIdentityScript()

  return new Promise<DriveSession>((resolve, reject) => {
    const oauth2 = window.google?.accounts?.oauth2
    if (!oauth2?.initTokenClient) {
      reject(new Error('Google OAuth kit yuklenmedi.'))
      return
    }

    const tokenClient = oauth2.initTokenClient({
      client_id: normalizedClientId,
      scope: GOOGLE_DRIVE_SCOPE,
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error))
          return
        }

        const accessToken = response.access_token?.trim()
        if (!accessToken) {
          reject(new Error('Google access token gelmedi.'))
          return
        }

        const expiresInSeconds = Number(response.expires_in ?? 0)
        const session: DriveSession = {
          accessToken,
          expiresAt:
            Date.now() + (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 300) * 1000,
        }
        driveSession = session
        resolve(session)
      },
      error_callback: (error) => {
        reject(new Error(error.type || 'Google auth popup baglandi.'))
      },
    })

    tokenClient.requestAccessToken({ prompt })
  })
}

export async function ensureDriveSession(
  clientId: string,
  forceConsent = false,
): Promise<DriveSession> {
  if (!forceConsent && driveSession && Date.now() < driveSession.expiresAt - 60_000) {
    return driveSession
  }

  return requestDriveToken(clientId, forceConsent || !driveSession ? 'consent' : '')
}

export function getDriveSessionState() {
  return driveSession
}

export function revokeDriveSession() {
  const token = driveSession?.accessToken
  driveSession = null

  if (token && window.google?.accounts?.oauth2?.revoke) {
    window.google.accounts.oauth2.revoke(token, () => {})
  }
}

async function parseGoogleError(res: Response): Promise<never> {
  const text = await res.text()

  let message = ''
  try {
    const payload = JSON.parse(text) as {
      error?: { message?: string }
    }
    message = payload.error?.message?.trim() ?? ''
  } catch {
    message = text.trim()
  }

  throw new Error(message || `Google Drive HTTP ${res.status}`)
}

async function googleJson<T>(
  url: string,
  accessToken: string,
  init: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {}),
    },
  })

  if (!res.ok) {
    await parseGoogleError(res)
  }

  return (await res.json()) as T
}

function toDrivePublicImageUrl(file: DriveFileMetadata): string {
  if (file.webContentLink?.trim()) {
    return file.webContentLink.trim()
  }
  if (!file.id) return ''
  return `https://drive.google.com/uc?export=view&id=${file.id}`
}

export async function uploadImageToGoogleDrive(
  file: File,
  accessToken: string,
): Promise<DriveUploadResult> {
  const metadata = {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
  }

  const sessionResponse = await fetch(
    `${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=id`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': metadata.mimeType,
        'X-Upload-Content-Length': String(file.size),
      },
      body: JSON.stringify(metadata),
    },
  )

  if (!sessionResponse.ok) {
    await parseGoogleError(sessionResponse)
  }

  const uploadUrl = sessionResponse.headers.get('Location')?.trim()
  if (!uploadUrl) {
    throw new Error('Google Drive resumable upload linki gelmedi.')
  }

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': metadata.mimeType,
    },
    body: file,
  })

  if (!uploadRes.ok) {
    await parseGoogleError(uploadRes)
  }

  const uploaded = (await uploadRes.json()) as DriveFileMetadata
  if (!uploaded.id) {
    throw new Error('Google Drive file id gelmedi.')
  }

  await googleJson<DrivePermissionResponse>(
    `${DRIVE_API_BASE}/files/${uploaded.id}/permissions`,
    accessToken,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        role: 'reader',
        type: 'anyone',
      }),
    },
  )

  const publicMeta = await googleJson<DriveFileMetadata>(
    `${DRIVE_API_BASE}/files/${uploaded.id}?fields=id,name,webContentLink,webViewLink,resourceKey,mimeType`,
    accessToken,
    {
      method: 'GET',
    },
  )

  const publicUrl = toDrivePublicImageUrl(publicMeta)
  if (!publicUrl) {
    throw new Error('Google Drive public sekil linki hazir olmadi.')
  }

  return {
    fileId: publicMeta.id,
    publicUrl,
    webViewLink: publicMeta.webViewLink?.trim() ?? '',
    name: publicMeta.name?.trim() ?? file.name,
  }
}
