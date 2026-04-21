# myshops-codex-meta

Bu proje `https://myshops.az/products.xml` feed-indən məhsulları oxuyur, ada görə tapır, cədvələ əlavə edir və Meta Commerce Manager üçün CSV ixrac edir.

`Gorseller ve videolar` sahəsini siz əl ilə doldurursunuz.
Her setirde 2 yol var:
- textarea-ya birbasa URL yazmaq (vergul, setirsonu ve ya noqte-vergul ile)
- `Media URL elave et` input-u ile URL daxil edib `Elave et` duymesine basmaq

## Quraşdırma və İşə Salma (Yükləmə)

1. Layihəni kompüterinizə klonlayın (yükləyin):
```bash
git clone https://github.com/samigiman/myshops-codex-meta.git
```

2. Layihənin qovluğuna daxil olun:
```bash
cd myshops-codex-meta
```

3. Paketləri yükləyin:
```bash
npm install
```

4. Layihəni işə salın:
```bash
npm run dev
```

Browser-də açın: `http://127.0.0.1:3007` (və ya terminalda göstərilən link)

## Istifade addimlari

1. `products.xml yukle` düyməsinə basın.
2. Axtarış qutusuna məhsul adını yazın.
3. `Uygunlari cedvele elave et` edin.
4. Cədvəldə lazım olan sahələri düzəldin:
   - Gorseller ve videolar
   - Title
   - Description
   - Website link
   - Price
   - Sale price (optional)
   - Facebook product category (optional)
   - Condition
   - Availability
   - Status
   - Brand (optional)
   - Content ID (optional)
   - Media URL yazdiqca kicik preview (sekil/video) gosterilir
   - `Qiymetleri yenile` ile mevcut setirlerde canli Price/Sale price yeniden hesablanir
5. `Meta CSV yukle` düyməsi ilə faylı yükləyin.
6. CSV xetasi almamaq ucun her setirde en azi 1 sekil URL olmalidir (`image_link` bos olmamalidir).
   - Sekil upload ile secilen kartlarda upload sekli cedvelde gosterilir.
   - CSV export-da `image_link` ucun yalniz public `http/https` URL istifade olunur; lokal `blob:` URL varsa feed `image_link` fallback edilir.

## Batch sekil analizi ve AI matching

- `Şəkilləri seç` ilə çoxlu şəkil yükləyin.
- Bir batch-da maksimum `300` şəkil emal olunur.
- Yeni AI pipeline 3 mərhələdə işləyir:
  - Şəkildən detallı məhsul profili çıxarır: brend, seriya/model, storage, rəng, görünən mətn, kateqoriya
  - Feed-dən top namizədləri yığır
  - Lazım olanda AI ilə bu namizədlər arasında ayrıca seçim edib ən uyğun `content_id`-ni önə çəkir
- Uyğun kartlarda Meta üçün `title` və `description` draft-ları da hazırlanır.
- `AI pick` olan kartlarda sistem uyğun namizədi önə çəkir; istəsən əl ilə başqa variant da seçə bilərsən.
- `Feed-də tapılmayanlar` ayrıca sütunda saxlanılır ki manual axtarış rahat olsun.
- `Top seçimi tətbiq et` ilə review-də qalan kartlarda birinci namizədi toplu seçmək olur.

## AI setup

AI analiz dev proxy üzərindən gedir; API açarları frontend-ə çıxmır.

### Gemini ile

```bash
GEMINI_API_KEY=...
VITE_GEMINI_MODEL=gemini-3.1-pro-preview
VITE_GEMINI_MODELS=gemini-3.1-pro-preview,gemini-3-flash-preview,gemini-2.5-pro,gemini-2.5-flash
```

### OpenAI ile

```bash
OPENAI_API_KEY=sk-...
VITE_OPENAI_VISION_MODEL=gpt-5.4
VITE_OPENAI_VISION_MODELS=gpt-5.4,gpt-5.2,gpt-5.1,gpt-5-mini,gpt-4.1
```

Qeyd:

- `VITE_OPENAI_VISION_MODEL` verilibsə sistem əvvəl OpenAI modelini yoxlayır.
- Hazırkı default prioritet `gemini-3.1-pro-preview` modelidir.
- Sistem əvvəl Gemini model siyahısını yoxlayır, sonra OpenAI-ni fallback kimi sınayır.
- Gemini analizi alınmasa kart AI nəticəsiz qalır və manual review ilə həll olunur.
- AI analizi həm matching üçün, həm də Meta draft generation üçün istifadə olunur.

## Qeyd

- Dev rejimdə `vite.config.ts` içində proxy var:
  - `/proxy-products.xml` -> `https://myshops.az/products.xml`
  - `/proxy-api2/*` -> `https://new.myshops.az/api2/*`
  - `/proxy-gemini/*` -> `https://generativelanguage.googleapis.com/v1beta/*` (yalniz `GEMINI_API_KEY` varsa)
  - `/proxy-openai/*` -> `https://api.openai.com/*` (yalniz `OPENAI_API_KEY` varsa)
- `Price` ve `Sale price` real mehsul API cavabindan (`price/taksit`) hesablanir; qalan field-ler XML feed-den gelir.
- CSV Meta kataloq formatı üçün bu sütunlarla çıxarılır:
  - `id,title,description,availability,condition,price,link,image_link,additional_image_link,brand,sale_price,fb_product_category,video_url`
