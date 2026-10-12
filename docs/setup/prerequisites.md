# Own-PC prerequisites: Windows and macOS

Install these before `npm ci`. Use a local folder outside synchronized/cloud-storage folders.
These are existing installers, not code the AI must generate. Account identity,
installer approval/admin passwords and browser sign-in remain human steps.

## Windows 10/11: PowerShell

Open PowerShell. If `winget --version` fails, install/update Microsoft's **App
Installer** from the Microsoft Store, then open a new PowerShell. Install:

```powershell
winget install --exact --id OpenJS.NodeJS.LTS --interactive
winget install --exact --id Python.Python.3.12 --interactive
winget install --exact --id Git.Git --interactive
winget install --exact --id Google.Chrome --interactive
```

In the Python installer enable **Add python.exe to PATH**. Open a fresh PowerShell
after installing, then verify (Node must be at least 20.9; Python at least 3.11):

```powershell
node --version
npm --version
python --version
git --version
```

If `python` opens the Store, use `py -3.12` instead of the guides' `python`, or
disable the Store Python app execution alias and reopen PowerShell.

For local **Docker/Supabase** only:

```powershell
wsl --install
winget install --exact --id Docker.DockerDesktop --interactive
```

Restart Windows if WSL/installer requests it. Open Docker Desktop, complete its
own setup/terms and wait for the Linux engine to run; confirm `docker version`
shows both client and server. Enable virtualization if Docker's installer asks.
Docker's licensing/system requirements apply. Native PostgreSQL needs no Docker;
follow [database-postgres.md](database-postgres.md) for PG17 installation/service.

## macOS: Terminal (Apple Silicon or Intel)

Use [Homebrew's official installation instructions](https://brew.sh/). Install
Apple's command-line tools with `xcode-select --install` if prompted, approve the
installer, and execute the `brew shellenv` line it prints for your actual install
location. Then:

```bash
brew install node@22 python@3.12 git
brew install --cask google-chrome
export PATH="$(brew --prefix node@22)/bin:$(brew --prefix python@3.12)/libexec/bin:$PATH"
node --version
npm --version
python3 --version
git --version
```

Add that PATH export to your own `~/.zprofile` to retain it in new login shells.
Use `python3` in place of the guides' `python`, or activate the virtual environment
below, which supplies `python`. For Docker/Supabase only:

```bash
brew install --cask docker
open -a Docker
docker version
```

Wait for the Docker Linux engine; a client version alone is insufficient. Native
PostgreSQL needs no Docker; follow [database-postgres.md](database-postgres.md).
Without Homebrew, use official [Node LTS](https://nodejs.org/en/download),
[Python macOS installers](https://www.python.org/downloads/macos/),
[Git installation](https://git-scm.com/downloads/mac),
[Chrome](https://www.google.com/chrome/) and
[Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/)
installers. Approve their UI and verify the same versions. Do not fabricate package
or service setup scripts.

## Clone and isolate importer dependencies

Windows:

```powershell
New-Item -ItemType Directory -Path "$HOME\apps" -Force
Set-Location "$HOME\apps"
git clone https://github.com/iScale-Builders/iscale-listings.git
Set-Location iscale-listings
python -m venv "$HOME\.iscale-listings\venv"
& "$HOME\.iscale-listings\venv\Scripts\python.exe" -m pip install -r scripts/requirements.txt
npm ci
npm link
```

Use the absolute venv Python path for imports and Task Scheduler; alternatively
activate it with `. "$HOME\.iscale-listings\venv\Scripts\Activate.ps1"` if your
execution policy allows. The walkthrough uses `python` to mean this venv Python.

macOS:

```bash
mkdir -p "$HOME/apps"
cd "$HOME/apps"
git clone https://github.com/iScale-Builders/iscale-listings.git
cd iscale-listings
python3 -m venv "$HOME/.iscale-listings/venv"
source "$HOME/.iscale-listings/venv/bin/activate"
python -m pip install -r scripts/requirements.txt
npm ci
npm link
```

`npm link` is optional; if it needs an administrator action or is unavailable,
use `node cli/iscale.mjs` in place of `iscale` throughout. Do not require sudo just
to use this CLI. Keep downloads, CSVs, reports, dumps and job work outside Git.
Next: [the single ordered local walkthrough](local-walkthrough.md).
