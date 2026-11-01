# 9Remote Installation Script for Windows
# Usage: irm https://raw.githubusercontent.com/jokerhung/1devterminal/master/install.ps1 | iex

$ErrorActionPreference = "Stop"

function Write-ColorOutput($ForegroundColor, $Message) {
    $fc = $host.UI.RawUI.ForegroundColor
    $host.UI.RawUI.ForegroundColor = $ForegroundColor
    Write-Output $Message
    $host.UI.RawUI.ForegroundColor = $fc
}

function Write-Info($Message) {
    Write-ColorOutput Blue "ℹ $Message"
}

function Write-Success($Message) {
    Write-ColorOutput Green "✓ $Message"
}

function Write-CustomError($Message) {
    Write-ColorOutput Red "✗ $Message"
}

function Write-Warning($Message) {
    Write-ColorOutput Yellow "⚠ $Message"
}

function Test-Command($Command) {
    try {
        if (Get-Command $Command -ErrorAction SilentlyContinue) {
            return $true
        }
    } catch {
        return $false
    }
    return $false
}

function Install-NodeJS {
    Write-Info "Node.js not found. Installing Node.js via winget..."

    if (Test-Command winget) {
        try {
            winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            Write-Success "Node.js installed successfully"
        } catch {
            Write-CustomError "Failed to install Node.js via winget"
            Write-Info "Please install Node.js manually from https://nodejs.org"
            exit 1
        }
    } else {
        Write-CustomError "winget not found. Please install Node.js manually from https://nodejs.org"
        exit 1
    }
}

function Install-Git {
    Write-Info "Git not found. Installing Git via winget..."

    if (Test-Command winget) {
        try {
            winget install -e --id Git.Git --silent --accept-source-agreements --accept-package-agreements
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            Write-Success "Git installed successfully"
        } catch {
            Write-CustomError "Failed to install Git via winget"
            Write-Info "Please install Git manually from https://git-scm.com"
            exit 1
        }
    } else {
        Write-CustomError "winget not found. Please install Git manually from https://git-scm.com"
        exit 1
    }
}

Write-Output ""
Write-Output "╔════════════════════════════════════════════════════════╗"
Write-Output "║                                                        ║"
Write-Output "║              9Remote Installation Script              ║"
Write-Output "║                                                        ║"
Write-Output "╚════════════════════════════════════════════════════════╝"
Write-Output ""

Write-Info "Checking prerequisites..."

if (-not (Test-Command node)) {
    Install-NodeJS
} else {
    $nodeVersion = node -v
    Write-Success "Node.js is already installed: $nodeVersion"
}

if (-not (Test-Command git)) {
    Install-Git
} else {
    $gitVersion = git --version
    Write-Success "Git is already installed: $gitVersion"
}

$installDir = Join-Path $env:USERPROFILE "1terminal"

if (Test-Path $installDir) {
    Write-Warning "Directory $installDir already exists."
    Write-Output ""
    Write-Output "1. Remove old directory and reinstall (fresh start)"
    Write-Output "2. Update to latest version (keeps local files)"
    Write-Output "3. Cancel"
    Write-Output ""
    $response = Read-Host "Choose option (1/2/3)"

    if ($response -eq '1') {
        Write-Info "Removing existing installation..."
        Remove-Item -Path $installDir -Recurse -Force
        Write-Info "Cloning 9Remote repository..."
        try {
            git clone https://github.com/jokerhung/1devterminal.git $installDir
            Set-Location $installDir
            Write-Success "Repository cloned successfully"
        } catch {
            Write-CustomError "Failed to clone repository: $_"
            exit 1
        }
    } elseif ($response -eq '2') {
        Write-Info "Updating to latest version..."
        try {
            Set-Location $installDir
            git fetch origin master
            git reset --hard origin/master
            Write-Success "Updated to latest version"
        } catch {
            Write-CustomError "Failed to update repository: $_"
            exit 1
        }
    } else {
        Write-CustomError "Installation cancelled"
        exit 1
    }
} else {
    Write-Info "Cloning 9Remote repository..."
    try {
        git clone https://github.com/jokerhung/1devterminal.git $installDir
        Set-Location $installDir
        Write-Success "Repository cloned successfully"
    } catch {
        Write-CustomError "Failed to clone repository: $_"
        exit 1
    }
}

Write-Info "Cloning 9Remote repository..."
try {
    git clone https://github.com/jokerhung/1devterminal.git $installDir
    Set-Location $installDir
    Write-Success "Repository cloned successfully"
} catch {
    Write-CustomError "Failed to clone repository: $_"
    exit 1
}

Write-Info "Installing dependencies... (this may take a few minutes)"
try {
    npm install
    Write-Success "Dependencies installed successfully"
} catch {
    Write-CustomError "Failed to install dependencies: $_"
    exit 1
}

Write-Info "Building host package..."
try {
    npm run host:build
    Write-Success "Host package built successfully"
} catch {
    Write-CustomError "Failed to build host package: $_"
    exit 1
}

$localIP = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Ethernet*","Wi-Fi*" -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress -like "192.168.*" -or $_.IPAddress -like "10.*"} | Select-Object -First 1).IPAddress
if (-not $localIP) {
    $localIP = "localhost"
}

Write-Info "Would you like to install 9Remote as a Windows Service? (recommended for auto-start)"
$serviceResponse = Read-Host "(y/N)"
if ($serviceResponse -eq 'y' -or $serviceResponse -eq 'Y') {
    Write-Info "Installing as Windows Service..."

    $serviceScript = Join-Path $installDir "start-service.ps1"
    @"
Set-Location "$installDir"
& node "$installDir\host\index.js" ui
"@ | Out-File -FilePath $serviceScript -Encoding UTF8

    $action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$serviceScript`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

    try {
        Register-ScheduledTask -TaskName "9Remote" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
        Write-Success "Windows Service (Task Scheduler) created successfully"
        Write-Info "The service will start automatically on system boot"
    } catch {
        Write-Warning "Failed to create scheduled task: $_"
        Write-Info "You can still start 9Remote manually"
    }
}

Write-Output ""
Write-Output "╔════════════════════════════════════════════════════════╗"
Write-Output "║                                                        ║"
Write-Output "║           ✓ Installation completed successfully       ║"
Write-Output "║                                                        ║"
Write-Output "╚════════════════════════════════════════════════════════╝"
Write-Output ""
Write-Success "9Remote is now installed at: $installDir"
Write-Output ""

Write-Info "Starting 9Remote server to initialize permanent key..."
Set-Location $installDir
try {
    $serverProcess = Start-Process PowerShell -ArgumentList "-NoProfile", "-Command", "cd '$installDir'; npm run host:dev:server" -PassThru -WindowStyle Hidden

    Write-Info "Waiting for server to be ready..."
    $maxAttempts = 30
    $serverReady = $false
    for ($i = 1; $i -le $maxAttempts; $i++) {
        Start-Sleep -Seconds 1
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:2208/api/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($response.StatusCode -eq 200) {
                Write-Success "Server is ready"
                $serverReady = $true
                break
            }
        } catch {
            # Continue waiting
        }
        if ($i -eq $maxAttempts) {
            Write-Warning "Server health check timeout"
            Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
            Write-CustomError "Failed to start server for key generation"
            exit 1
        }
    }

    if ($serverProcess.HasExited) {
        Write-CustomError "Server process died unexpectedly"
        exit 1
    }

    Write-Info "Generating permanent API key..."
    Start-Sleep -Seconds 2

    $keysFile = Join-Path $env:USERPROFILE ".9remote\keys.json"
    if (Test-Path $keysFile) {
        $keysContent = Get-Content $keysFile -Raw | ConvertFrom-Json
        if ($keysContent.activeKey -match "sk-") {
            Write-Success "Permanent key generated: $($keysContent.activeKey)"
        } else {
            Write-Warning "Key file exists but could not extract key value"
        }
    } else {
        Write-Warning "Key file not found at $keysFile"
    }

    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Write-Success "Server stopped"
} catch {
    Write-Warning "Error during initialization: $_"
}

Write-Output ""
Write-Info "To start the server manually, run:"
Write-ColorOutput Green "  cd $installDir"
Write-ColorOutput Green "  npm run dev:local"
Write-Output ""
Write-Info "Access the web interface at:"
Write-ColorOutput Green "  http://localhost:2208/workspace"
if ($localIP -ne "localhost") {
    Write-ColorOutput Green "  http://${localIP}:2208/workspace (LAN access)"
}
Write-Output ""
Write-Info "For remote access, use Cloudflare Tunnel:"
Write-ColorOutput Green "  cloudflared tunnel --url http://localhost:2208"
Write-Output ""

$startNow = Read-Host "Would you like to start 9Remote now? (y/N)"
if ($startNow -eq 'y' -or $startNow -eq 'Y') {
    Write-Info "Starting 9Remote in new window..."

    if ($serviceResponse -eq 'y' -or $serviceResponse -eq 'Y') {
        try {
            Start-ScheduledTask -TaskName "9Remote"
            Write-Success "9Remote service started"
            Write-Info "Opening browser in 8 seconds..."
            Start-Sleep -Seconds 8
            Start-Process "http://localhost:2208/workspace"
        } catch {
            Write-Warning "Failed to start service. Starting manually..."
            Start-Process PowerShell -ArgumentList "-NoExit", "-Command", "cd '$installDir'; npm run dev:local"
            Write-Info "Opening browser in 8 seconds..."
            Start-Sleep -Seconds 8
            Start-Process "http://localhost:2208/workspace"
        }
    } else {
        Start-Process PowerShell -ArgumentList "-NoExit", "-Command", "cd '$installDir'; npm run dev:local"
        Write-Info "Opening browser in 8 seconds..."
        Start-Sleep -Seconds 8
        Start-Process "http://localhost:2208/workspace"
    }
}
