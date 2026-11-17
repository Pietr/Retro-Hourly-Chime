Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Sygnal Godzinowy (Hourly Chime) - Zepp OS" -ForegroundColor Cyan
Write-Host "  Generowanie kodu QR w chmurze Zepp (dziala przez 4G/5G)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Jesli pojawi sie okno przegladarki, zaloguj sie kontem Zepp." -ForegroundColor Yellow
Write-Host "2. W aplikacji Zepp na telefonie wlacz Tryb Deweloperski:" -ForegroundColor Yellow
Write-Host "   Profil -> Ustawienia -> O aplikacji -> kliknij 7x logo Zepp." -ForegroundColor Gray
Write-Host "3. Wejdz w Profil -> Moj zegarek -> Tryb deweloperski" -ForegroundColor Yellow
Write-Host "   -> Mini Program -> '+' -> Skanuj kod QR wyswietlony ponizej." -ForegroundColor Gray
Write-Host "   (Telefon NIE musi byc w tej samej sieci Wi-Fi co komputer!)" -ForegroundColor Green
Write-Host ""

if (Get-Command zeus -ErrorAction SilentlyContinue) {
    zeus preview
} else {
    Write-Host "[INFO] Uruchamianie przez npx @zeppos/zeus-cli preview..." -ForegroundColor Cyan
    npx --yes @zeppos/zeus-cli preview
}
