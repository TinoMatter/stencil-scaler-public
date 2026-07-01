param(
  [int]$Port = 8765,
  [string]$Root = (Get-Location).Path
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
  throw "Root folder not found: $Root"
}

function Get-ContentType {
  param([string]$Path)

  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    ".html" { "text/html; charset=utf-8"; break }
    ".htm" { "text/html; charset=utf-8"; break }
    ".js" { "application/javascript; charset=utf-8"; break }
    ".mjs" { "application/javascript; charset=utf-8"; break }
    ".css" { "text/css; charset=utf-8"; break }
    ".json" { "application/json; charset=utf-8"; break }
    ".pdf" { "application/pdf"; break }
    ".png" { "image/png"; break }
    ".jpg" { "image/jpeg"; break }
    ".jpeg" { "image/jpeg"; break }
    ".svg" { "image/svg+xml"; break }
    ".txt" { "text/plain; charset=utf-8"; break }
    default { "application/octet-stream"; break }
  }
}

function Send-TextResponse {
  param(
    [System.Net.HttpListenerContext]$Context,
    [int]$StatusCode,
    [string]$Text
  )

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
  $response = $Context.Response
  $response.StatusCode = $StatusCode
  $response.ContentType = "text/plain; charset=utf-8"
  $response.ContentLength64 = $bytes.Length
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
  $response.OutputStream.Close()
}

$rootFull = [System.IO.Path]::GetFullPath((Join-Path $Root "."))
$prefix = "http://127.0.0.1:$Port/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
} catch {
  Write-Host "Could not start local server on $prefix" -ForegroundColor Red
  Write-Host "Close other app using this port or start with another port." -ForegroundColor Yellow
  Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Yellow
  exit 1
}

Start-Sleep -Milliseconds 250
Start-Process "$prefix`index.html" | Out-Null
Write-Host "Stoma scaler local server running at $prefix"
Write-Host "Press Ctrl+C or close this window to stop."

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $requestPath = [System.Uri]::UnescapeDataString($context.Request.Url.AbsolutePath)
    if ([string]::IsNullOrWhiteSpace($requestPath) -or $requestPath -eq "/") {
      $requestPath = "/index.html"
    }

    $relativePath = $requestPath.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)
    $candidatePath = Join-Path $rootFull $relativePath
    $fullPath = [System.IO.Path]::GetFullPath($candidatePath)

    if (-not $fullPath.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
      Send-TextResponse -Context $context -StatusCode 403 -Text "403 Forbidden"
      continue
    }

    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      Send-TextResponse -Context $context -StatusCode 404 -Text "404 Not Found"
      continue
    }

    $fileBytes = [System.IO.File]::ReadAllBytes($fullPath)
    $response = $context.Response
    $response.StatusCode = 200
    $response.ContentType = Get-ContentType -Path $fullPath
    $response.ContentLength64 = $fileBytes.Length
    $response.OutputStream.Write($fileBytes, 0, $fileBytes.Length)
    $response.OutputStream.Close()
  }
} catch [System.Net.HttpListenerException] {
  # Expected when the listener is stopped.
} catch {
  Write-Host "Local server stopped with error: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  if ($listener) {
    $listener.Stop()
    $listener.Close()
  }
}