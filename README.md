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

## Batch sekil adindan axtaris

- `Sekilleri yukle ve adla axtar` ile coxlu sekil secin.
- Bir batch-da maksimum `300` sekil emal olunur.
- Sistem her sekil adindan sorgu cixarib feed-de mehsul tapir.
- 1 netice olarsa avtomatik cedvele elave edir.
- 2+ netice olarsa sekil kartinin altinda namized mehsullar gorunur, siz uygun olani secirsiniz.
- Namized mehsullarda `Reng` melumati da gosterilir ki secim daha rahat olsun.
- Secildikden sonra kartda `Secilen reng` ayrica gosterilir.
- `Tovsiyeni sec` ve `Top 1-leri toplu sec` secimi AI reng ipucunu da nezere alir.
- Eger fayl adi yeterli olmazsa AI vision ile sekil uzerinden mehsul adini oxuyub axtarisi guclendirir (fallback OCR).
- `Uygun mehsul tapilmadi` kartlarinda manual input ile ad yazib tekrar axtar etmek mumkundur.
- Yanlis secim etdikde kart uzerinden `Sechimi deyish` ile geri qaytarib yeniden secmek olur.
- Cox secim oldugunda `Top 1-leri toplu sec` duymesi ile butun kartlarda ilk namized bir klikle secilir.

## AI vision ucun (Gemini) setup

AI ile sekilden ad oxuma dev proxy uzerinden gedir. API acari frontend-e cixmir.

`.env` faylina elave edin:

```bash
GEMINI_API_KEY=...
VITE_GEMINI_MODEL=gemini-3-flash-preview
VITE_GEMINI_MODELS=gemini-3-flash-preview,gemini-3.1-pro-preview,gemini-2.5-pro,gemini-2.5-flash
```

Optional fallback:

```bash
OPENAI_API_KEY=sk-...
VITE_OPENAI_VISION_MODEL=gpt-4.1-mini
```

Qeyd: sistem evvel model siyahisini yoxlayib en guclu uygun Gemini modeline kecir.
Gemini 3 ucun image analiz keyfiyyeti artirmaq meqsedi ile `mediaResolution=high` istifade olunur.
API key yoxdursa sistem avtomatik fallback OCR istifade edir.

## Qeyd

- Dev rejimdə `vite.config.ts` içində proxy var:
  - `/proxy-products.xml` -> `https://myshops.az/products.xml`
  - `/proxy-api2/*` -> `https://new.myshops.az/api2/*`
  - `/proxy-gemini/*` -> `https://generativelanguage.googleapis.com/v1beta/*` (yalniz `GEMINI_API_KEY` varsa)
  - `/proxy-openai/*` -> `https://api.openai.com/*` (yalniz `OPENAI_API_KEY` varsa)
- `Price` ve `Sale price` real mehsul API cavabindan (`price/taksit`) hesablanir; qalan field-ler XML feed-den gelir.
- CSV Meta kataloq formatı üçün bu sütunlarla çıxarılır:
  - `id,title,description,availability,condition,price,link,image_link,additional_image_link,brand,sale_price,fb_product_category,video_url`
