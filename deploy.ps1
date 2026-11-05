# 수입차 사이트 3개 저장소 공통 배포
# 이 파일을 수입차 사이트의 index.html과 같은 폴더에 저장하세요.
# 아래 GitHub 저장소 주소 3개는 기존 파일에서 유지했습니다.
# 각 저장소 CNAME은 보존하며 index.html의 title만 배포 대상별로 설정합니다.

$ErrorActionPreference = "Stop"
$source = $PSScriptRoot

$repos = @(
    @{ Name = "수입차"; Url = "https://github.com/autogenie4411-eng/importcar.git" },
    @{ Name = "수입차 구글용"; Url = "https://github.com/autogenie4411-eng/icar.git" },
    @{ Name = "수입차 네이버배너용"; Url = "https://github.com/autogenie4411-eng/nicar.git" }
)

if (-not (Test-Path (Join-Path $source "index.html"))) {
    throw "deploy.ps1을 index.html이 있는 수입차 사이트 폴더에 넣어주세요."
}

foreach ($repo in $repos) {
    if ($repo.Url -match '사용자명|저장소') {
        throw "$($repo.Name)의 Url을 실제 GitHub 저장소 주소로 변경하세요: $($repo.Url)"
    }
}

$tempRoot = Join-Path $env:TEMP ("importcar-deploy-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    foreach ($repo in $repos) {
        Write-Host "`n[$($repo.Name)] 배포 시작" -ForegroundColor Cyan
        $target = Join-Path $tempRoot ([guid]::NewGuid().ToString("N"))

        & git -c core.longpaths=true clone --quiet --branch main --single-branch -- $repo.Url $target
        if ($LASTEXITCODE -ne 0) { throw "$($repo.Name): 저장소 복제 실패" }

        $cnamePath = Join-Path $target "CNAME"
        if (-not (Test-Path $cnamePath)) {
            throw "$($repo.Name): 원격 main에 CNAME 파일이 없습니다. 먼저 저장소의 CNAME을 확인하세요."
        }
        $originalCname = [System.IO.File]::ReadAllBytes($cnamePath)

        # 기존 원격 저장소의 CNAME은 덮어쓰지 않습니다.
        # 이 방식은 원본에서 삭제한 파일을 원격에서 자동 삭제하지 않습니다.
        & robocopy $source $target /E /R:1 /W:1 /XF CNAME deploy.ps1 .env .env.* /XD .git .github .vscode node_modules
        if ($LASTEXITCODE -ge 8) { throw "$($repo.Name): 파일 복사 실패 (robocopy exit $LASTEXITCODE)" }

        # 사이트별 페이지 제목 적용 (원본 index.html은 변경하지 않음)
        $indexPath = Join-Path $target "index.html"
        $html = [System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8)

        switch ($repo.Name) {
            "수입차" { $pageTitle = "오토지니 IMPORT | 수입차 장기렌트·리스 견적 비교" }
            "수입차 구글용" { $pageTitle = "오토지니 IMPORT G | 수입차 장기렌트·리스 견적 비교" }
            "수입차 네이버배너용" { $pageTitle = "오토지니 IMPORT N | 수입차 장기렌트·리스 견적 비교" }
            default { throw "$($repo.Name): 알 수 없는 배포 대상입니다." }
        }

        $titlePattern = '(?is)<title\b[^>]*>.*?</title>'
        $titleMatches = [regex]::Matches($html, $titlePattern)
        if ($titleMatches.Count -ne 1) {
            throw "$($repo.Name): index.html의 title 태그가 정확히 1개여야 합니다. 현재 $($titleMatches.Count)개입니다."
        }
        $html = [regex]::Replace(
            $html, $titlePattern,
            [System.Text.RegularExpressions.MatchEvaluator]{ param($m) "<title>$pageTitle</title>" }
        )

        # 수입차 세 사이트에는 Smartlog 추적 코드가 없어야 합니다.
        # Smartlog 전용 코드만 제거하며 다른 스크립트는 그대로 유지합니다.
        $html = [regex]::Replace($html, '(?is)<!--\s*Smartlog\s*-->\s*', '')
        $html = [regex]::Replace($html, '(?is)<script\b[^>]*>\s*var\s+hpt_info\s*=.*?</script>\s*', '')
        $html = [regex]::Replace($html, '(?is)<script\b(?=[^>]*\bsrc\s*=\s*["''](?:(?:https?:)?//)?cdn\.smlog\.co\.kr/core/smart\.js["''])[^>]*>\s*</script>\s*', '')
        $html = [regex]::Replace($html, '(?is)<noscript\b[^>]*>\s*<img\b[^>]*\bsrc\s*=\s*["''](?:(?:https?:)?//)?a\d+\.smlog\.co\.kr/smart_bda\.php\?[^"'']*["''][^>]*>\s*</noscript>\s*', '')
        if ($html -match 'hpt_info|cdn\.smlog\.co\.kr/core/smart\.js|smart_bda\.php') {
            throw "$($repo.Name): Smartlog 코드가 남아 있어 안전을 위해 배포를 중단했습니다."
        }

        # UTF-8로 index.html 저장 (파일명 및 나머지 경로 유지)
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($indexPath, $html, $utf8NoBom)

        # CNAME이 변경되지 않았는지 바이트 단위 확인
        $currentCname = [System.IO.File]::ReadAllBytes($cnamePath)
        if (-not [System.Linq.Enumerable]::SequenceEqual([byte[]]$originalCname, [byte[]]$currentCname)) {
            throw "$($repo.Name): CNAME 변경이 감지되어 배포를 중단했습니다."
        }

        Push-Location $target
        try {
            & git add -A
            if ($LASTEXITCODE -ne 0) { throw "$($repo.Name): git add 실패" }
            & git restore --staged -- CNAME
            if ($LASTEXITCODE -ne 0) { throw "$($repo.Name): CNAME 보호 실패" }

            & git diff --cached --quiet
            if ($LASTEXITCODE -eq 0) {
                Write-Host "[$($repo.Name)] 변경사항 없음 (CNAME 유지)" -ForegroundColor Yellow
                continue
            }
            if ($LASTEXITCODE -ne 1) { throw "$($repo.Name): 변경사항 검사 실패" }

            & git commit -m "수입차 사이트 공통 업데이트"
            if ($LASTEXITCODE -ne 0) { throw "$($repo.Name): 커밋 실패" }
            & git push origin main
            if ($LASTEXITCODE -ne 0) { throw "$($repo.Name): push 실패. 원격 저장소의 최신 상태를 확인하세요." }

            Write-Host "[$($repo.Name)] 배포 완료 (기존 CNAME 유지)" -ForegroundColor Green
        }
        finally {
            Pop-Location
        }
    }
}
finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
