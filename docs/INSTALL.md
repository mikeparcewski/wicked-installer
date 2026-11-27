# Install Wicked Crew on macOS or Windows (WSL2)

This guide was checked against wicked-installer 0.11.3 and wicked-crew 0.20.0.

Wicked Crew is provided as-is. There's no committed support, SLA or production-readiness claim.

You're responsible for your environment and your AI usage. You choose where it runs, which code and documents it sees, and which AI accounts it uses. Claude Code and Codex use your own subscriptions or API entitlements, so any provider costs are yours. Get your organization's approval for those accounts and for the data you'll use with them before you start.

## Contents

- [Overview](#overview)
- [Security and data: read before installing](#security-and-data-read-before-installing)
- [Before you start](#before-you-start)
- [macOS install](#macos-install)
- [Windows install (WSL2)](#windows-install-wsl2)
- [Keeping it running](#keeping-it-running)
- [Upgrading](#upgrading)
- [Troubleshooting](#troubleshooting)

## Overview

One installer command installs Wicked Crew: the daemon, the bundled Studio UI and the tools it uses. You then start the daemon with `wicked-crew serve` and open Studio in your browser at http://127.0.0.1:7701.

The installer also prints "Run /wicked-garden-core setup in Claude Code to complete configuration". That step is for using Wicked Garden in your own Claude Code sessions; Wicked Crew doesn't need it.

| | |
|---|---|
| Installer | `wicked-installer` |
| Installs | the newest `wicked-crew` on npm, with Studio bundled, plus `wicked-estate`, `wicked-garden`, `wicked-vault` and `wicked-interactive` |
| Port | 7701, on the loopback address only (127.0.0.1) |
| Agents that do governed work | Claude Code and Codex |
| Local Kubernetes | Rancher Desktop |

**How agents run.** Each agent seat runs in an isolated container on a local Kubernetes cluster (Rancher Desktop). Each repository's own checks (tests, builds) run in a container too: always on Windows, and on macOS when a container can start (otherwise in the macOS sandbox). Jobs run gates, an independent review by a second agent, QE acceptance and rule checks, and say so when any of them is skipped. If Kubernetes won't work on your machine, [Troubleshooting](#fallbacks-when-the-containers-wont-work) has fallbacks and says what each one gives up.

**What's been checked.** macOS has been run end to end: a fresh install, then a governed job delivered as a pull request. On Windows, the Linux half (everything inside Ubuntu) has been tested; Windows itself has not been run end to end yet. On native Windows (without WSL2), agent seats can't run in containers, so this guide uses WSL2.

**Why Rancher Desktop.** Crew needs the cluster to limit how many processes each pod can start (the kubelet's `pod-max-pids`, 4096 or less). Rancher Desktop lets you set that, and this guide shows how. Docker Desktop's Kubernetes can't set the pod process limit the installer requires; use Rancher Desktop.

## Security and data: read before installing

| Boundary | What it means | What we recommend |
|---|---|---|
| Agents run in containers | Agent seats run in isolated containers. Repository checks run in containers on Windows; on macOS they try a container and fall back to the macOS sandbox if one can't start. With the local fallback (see [Troubleshooting](#fallbacks-when-the-containers-wont-work)), agents run as ordinary processes under your user, without the container boundary. | Use an isolated development environment: a dedicated machine or VM with test accounts and only the repositories you intend to use. Not a corporate workstation with production access, secrets or customer data. |
| Code and documents go to AI providers | Claude Code and Codex send the code, documents and prompts they work on to Anthropic and OpenAI under your accounts. | Use only accounts your organization has approved, and only code and documents you're allowed to share with those providers. |
| Studio is local | The daemon listens on 127.0.0.1:7701 only. It answers only requests addressed to `127.0.0.1` or `localhost`, and refuses changes from other websites. It has no login of its own. | Don't expose the port, forward it, or bind it to another address. Anyone who can reach it on your machine can use it. |
| Pull requests | Delivered jobs push branches and open pull requests with the GitHub account `gh` is signed in to, and commit with your git name and email. | Use a GitHub account and repositories meant for this trial. |

## Before you start

You need these on macOS, or inside the WSL2 Ubuntu on Windows, plus Rancher Desktop with Kubernetes. The install commands for each platform are in its section.

| Tool | Version | Why |
|---|---|---|
| Node.js | 22.12 or newer | wicked-crew is built and tested on Node 22.12+. The installer itself runs on Node 20+. |
| Python | 3.10 or newer | garden's hooks and scripts |
| uv | any recent | crew runs garden's Python tools through it |
| git | any recent, with your name and email set | jobs work in git worktrees and commit the result |
| GitHub CLI (`gh`) | any recent, signed in | delivering a job opens a pull request |
| Claude Code CLI (`claude`) | current | governed seat; you sign in from Studio |
| Codex CLI (`codex`) | current | governed seat; you sign in from Studio |
| whisper.cpp | optional | needed only for voice. macOS: `brew install whisper-cpp` (it provides `whisper-cli`). Ubuntu (WSL2): from the package manager or a build from github.com/ggml-org/whisper.cpp, so `whisper-cli` is on PATH, or set `WICKED_CREW_WHISPER_BIN`. Studio asks before it downloads the 142 MiB speech model. |
| bubblewrap (`bwrap`) | Linux/WSL2 only | not needed on the main path; only for the local fallback on Windows (see [Troubleshooting](#fallbacks-when-the-containers-wont-work)) |

You also need a Claude account and an OpenAI/ChatGPT account for the two agents. Sign-in happens in a browser.

## macOS install

About 20 minutes on a Mac with Homebrew.

### 1. Install the prerequisites

```bash
brew install node@22 python@3.12 uv git gh
brew link --overwrite node@22
PY312="$(brew --prefix python@3.12)/libexec/bin"
grep -qsF "export PATH=\"$PY312:\$PATH\"" ~/.zprofile || echo "export PATH=\"$PY312:\$PATH\"" >> ~/.zprofile
export PATH="$PY312:$PATH"
python3 --version
npm install -g @anthropic-ai/claude-code @openai/codex
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
gh auth login
```

- `python3 --version` must print 3.10 or newer (Homebrew's 3.12). Homebrew puts only `python3.12` in its main `bin` directory (its `python3` is in `python@3.12/libexec/bin`), and macOS's own `python3` is older, so the `PY312` lines put Homebrew's `python3` first on your PATH, now and in new Terminal windows. Running the lines again doesn't add the line twice.
- `~/.zprofile` is read by zsh, macOS's default shell, when it starts as a login shell, which is how Terminal opens new windows. A terminal app that starts a non-login zsh reads only `~/.zshrc`. If `python3 --version` prints the old version there, add the same `export PATH=…` line to `~/.zshrc`.
- Put your own name and email in the two `git config` lines. Delivered jobs commit with them. Skip them if `git config user.email` already prints the right address.
- `gh auth login` signs GitHub CLI in to your account. Follow its prompts and choose to log in with a web browser.

### 2. Install Rancher Desktop and turn on Kubernetes

Install [Rancher Desktop](https://rancherdesktop.io/) and change these settings in **Preferences**:

| Setting | Value |
|---|---|
| Container Engine | dockerd (moby), not containerd |
| Kubernetes | Enable Kubernetes |
| Virtual Machine → Hardware | 8 GB of memory or more |

### 3. Limit processes per pod

Run this once, after Rancher Desktop has started at least once. It adds a startup script that sets the kubelet's `pod-max-pids` to 4096. If you already have an `override.yaml`, add the `provision` entry to it instead of replacing the file. The script writes `/etc/rancher/k3s/config.yaml.d/wicked-pids.yaml` inside Rancher Desktop's VM. k3s merges that file with `config.yaml` and adds its `kubelet-arg` entry to any you already have there, so your own settings stay.

```bash
mkdir -p ~/Library/Application\ Support/rancher-desktop/lima/_config
cat > ~/Library/Application\ Support/rancher-desktop/lima/_config/override.yaml <<'EOF'
provision:
- mode: system
  script: |
    #!/bin/sh
    mkdir -p /etc/rancher/k3s/config.yaml.d
    cat > /etc/rancher/k3s/config.yaml.d/wicked-pids.yaml <<'K3S'
    kubelet-arg+:
      - "pod-max-pids=4096"
    K3S
EOF
```

Quit Rancher Desktop and start it again. When it says Kubernetes is running, check the node and its limit:

```bash
kubectl --context rancher-desktop get nodes
kubectl --context rancher-desktop get --raw "/api/v1/nodes/$(kubectl --context rancher-desktop get nodes -o jsonpath='{.items[0].metadata.name}')/proxy/configz" | python3 -c 'import json,sys; print(json.load(sys.stdin)["kubeletconfig"]["podPidsLimit"])'
```

One node should show `Ready`, and the second command should print `4096`.

### 4. Run the installer

```bash
npx -y wicked-installer@latest install wicked-crew wicked-interactive
grep -qsF 'export PATH="$HOME/.local/bin:$PATH"' ~/.zprofile || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile
export PATH="$HOME/.local/bin:$PATH"
```

The installer puts `wicked-estate` and `wicked-estate-mcp` (and `uv`, when it installs it) in `~/.local/bin`, which is not on macOS's default PATH; the last two lines add it so `wicked-estate` works in your shell. It installs crew and sets up crew's part of the cluster. Its readiness list should show local Kubernetes ready, and it should end by telling you how to start Studio. If it ends with "Installed, but Wicked Crew can't run jobs yet", fix the pending lines it lists (see [Troubleshooting](#troubleshooting)) and run it again.

### 5. Start the daemon and sign in

```bash
wicked-crew serve
```

Open http://127.0.0.1:7701, go to **Helpers**, and sign in Claude Code and Codex. On a fresh install both start signed out.

Check it in a second Terminal window: `curl -s http://127.0.0.1:7701/api/v1/health` should report `"status":"ok"`. Then register a repository under **Repositories** and ask the Desk chat about it. **From a URL** clones with the git on this computer, so a private repository works there only if `git clone` of that URL already works in your Terminal without asking for a password. Otherwise clone it yourself and add its folder with **On this computer**.

## Windows install (WSL2)

> **Experimental: the Linux half is tested; Windows itself has not been run end to end yet.** If you're testing on Windows, please [tell us](#if-youre-testing-on-windows-tell-us-about) what you see.

On Windows, the agents run in isolated Linux containers on Rancher Desktop's built-in Kubernetes. Crew itself runs inside an Ubuntu window (WSL2). Studio opens in your normal Windows browser. You need Windows 10 22H2 or 11, and 16 GB of RAM or more.

### 1. Install WSL2 and Ubuntu

In PowerShell as Administrator:

```powershell
wsl --install -d Ubuntu-24.04
```

Restart when asked, open Ubuntu from the Start menu, and create your Linux user. Run every later command in this Ubuntu window unless the step says otherwise.

### 2. Install the prerequisites

```bash
sudo apt update && sudo apt install -y git gh python3 python3-venv curl build-essential wslu
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc && nvm install 22
curl -LsSf https://astral.sh/uv/install.sh | sh
npm install -g @anthropic-ai/claude-code @openai/codex
echo 'export BROWSER=wslview' >> ~/.bashrc
echo 'export WICKED_FLOOR_RUNNER=container' >> ~/.bashrc
source ~/.bashrc
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
gh auth login
```

- Put your own name and email in the two `git config` lines. Delivered jobs commit with them.
- `gh auth login` signs GitHub CLI in to your account. Follow its prompts and choose to log in with a web browser.
- `wslu` provides `wslview`, `wslvar` and `wslpath`, used below. `BROWSER=wslview` lets command-line sign-ins such as `gh auth login` open your Windows browser.
- `WICKED_FLOOR_RUNNER=container` makes each repository's own checks run in an isolated container too.

### 3. Install Rancher Desktop and turn on Kubernetes

On Windows, install [Rancher Desktop](https://rancherdesktop.io/) and change these settings in **Preferences**:

| Setting | Value |
|---|---|
| Container Engine | dockerd (moby), not containerd |
| Kubernetes | Enable Kubernetes |
| WSL → Integrations | turn on Ubuntu-24.04 |

### 4. Limit processes per pod

Run this once, after Rancher Desktop has started at least once. It adds a startup script to Rancher Desktop's provisioning folder that sets the kubelet's `pod-max-pids` to 4096. Writing it from Ubuntu keeps the Unix line endings Rancher Desktop needs. The script writes `/etc/rancher/k3s/config.yaml.d/wicked-pids.yaml` inside Rancher Desktop's VM. k3s merges that file with `config.yaml` and adds its `kubelet-arg` entry to any you already have there, so your own settings stay.

```bash
RDP="$(wslpath "$(wslvar LOCALAPPDATA | tr -d '\r')")/rancher-desktop/provisioning"
mkdir -p "$RDP"
cat > "$RDP/wicked-pids.start" <<'EOF'
#!/bin/sh
mkdir -p /etc/rancher/k3s/config.yaml.d
cat > /etc/rancher/k3s/config.yaml.d/wicked-pids.yaml <<'K3S'
kubelet-arg+:
  - "pod-max-pids=4096"
K3S
EOF
```

Quit Rancher Desktop (File → Exit) and start it again.

### 5. Check the cluster from Ubuntu

When Rancher Desktop says Kubernetes is running, close and reopen Ubuntu, then:

```bash
kubectl --context rancher-desktop get nodes
kubectl --context rancher-desktop get --raw "/api/v1/nodes/$(kubectl --context rancher-desktop get nodes -o jsonpath='{.items[0].metadata.name}')/proxy/configz" | python3 -c 'import json,sys; print(json.load(sys.stdin)["kubeletconfig"]["podPidsLimit"])'
```

One node should show `Ready`, and the second command should print `4096`.

- If Ubuntu says `kubectl: command not found`, WSL integration isn't on for Ubuntu-24.04: turn it on (step 3), close and reopen Ubuntu, and try again.
- If it says there's no configuration, copy it from your Windows home folder, then try again:

  ```bash
  WINHOME="$(wslpath "$(wslvar USERPROFILE | tr -d '\r')")"
  mkdir -p ~/.kube && cp "$WINHOME/.kube/config" ~/.kube/config && chmod 600 ~/.kube/config
  ```

- If the second command prints a number other than 4096 (`-1` means no limit), check that step 4's file exists and that Rancher Desktop was restarted after it.

### 6. Install and start

The installer puts `wicked-estate` (and other tools) in `~/.local/bin`. Ubuntu's own `~/.profile` adds that folder to PATH in every new Ubuntu terminal once it exists; the `export` line below adds it to this one. `wicked-crew serve` keeps running in this window.

```bash
npx -y wicked-installer@latest install wicked-crew wicked-interactive
export PATH="$HOME/.local/bin:$PATH"
wicked-crew serve
```

The installer sets up crew's part of the cluster. Its readiness list should show local Kubernetes ready. If it says "no kubeconfig defines a local context (rancher-desktop or docker-desktop)", go back to step 5 until `kubectl --context rancher-desktop get nodes` shows `Ready`, then run the installer again. Don't set the fallback variables from [Troubleshooting](#fallbacks-when-the-containers-wont-work) unless the main path fails.

### 7. Open Studio and sign in

In your Windows browser, open http://localhost:7701. Go to **Helpers** and sign in Claude Code and Codex. If a sign-in page doesn't open by itself, copy its link into your Windows browser.

To check it from a second Ubuntu window: `curl -s http://127.0.0.1:7701/api/v1/health` should report `"status":"ok"`. Then register a repository under **Repositories** and ask the Desk chat about it. **From a URL** clones with the git in Ubuntu, so a private repository works there only if `git clone` of that URL already works in Ubuntu without asking for a password. Otherwise clone it yourself and add its folder with **On this computer**.

Keep your repositories inside Ubuntu, for example under `~/code`, not under `/mnt/c`. Windows drives are slow from Ubuntu and break git worktrees.

### If you're testing on Windows, tell us about

Open an issue on this repository with what you saw for any of these:

- **WSL version.** `wsl -l -v` (in PowerShell) should show VERSION 2 for Ubuntu-24.04. Did the install need a restart, admin rights, or virtualization turned on in the BIOS/UEFI?
- **Pod process limit.** Did `wslvar LOCALAPPDATA` find your folder, and did the `wicked-pids.start` script take effect (the limit check printed `4096` after the restart)?
- **WSL integration.** After you turned it on, did `command -v kubectl docker` find both in Ubuntu? Did `~/.kube/config` have a context named `rancher-desktop`? (By default crew looks only for `rancher-desktop` or `docker-desktop`, never the current context.)
- **Copied kubeconfig.** If you had to copy it, did `kubectl get nodes` work right after the copy?
- **Browser to `localhost:7701`.** Did Studio load from Windows? If not, did `http://127.0.0.1:7701` work, or a change to `localhostForwarding` (or mirrored networking) in `.wslconfig` followed by `wsl --shutdown` in PowerShell?
- **Sign-in links.** Could you finish the Claude Code and Codex sign-ins from Studio in your Windows browser?
- **systemd.** Does `systemctl --user status` work without changes? Does WSL shut Ubuntu down when idle and take the daemon with it?
- **Security software.** Did Smart App Control or Defender block or slow the Rancher Desktop installer, `wsl.exe`, or downloads?
- **Repository checks.** With `WICKED_FLOOR_RUNNER=container`, did verify gates run, or were they all denied? If denied, what does `command -v docker` print in Ubuntu?

Before you paste logs or command output into an issue, remove anything private: names, paths, repository names and URLs.

## Keeping it running

On Windows, `WICKED_FLOOR_RUNNER=container` must be set when the daemon starts; step 2 adds it to `~/.bashrc`. If you use a fallback from [Troubleshooting](#fallbacks-when-the-containers-wont-work), its variables must be set every time too.

**Run it as a login service (recommended on macOS).** Stop the hand-started daemon (Ctrl+C), then run this from the shell you normally start it in:

```bash
wicked-crew serve --install-service
```

This writes a LaunchAgent on macOS or a systemd user unit on Linux/WSL2. It keeps `PATH`, `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GH_ACCOUNT` and the `WICKED_*` variables from that shell, and leaves out any variable whose name or value looks like a secret. It saves them once: if you change any of them later, run `wicked-crew serve --install-service` again from that shell. The service writes its log to `~/.wicked-crew/daemon-stdout.log`. To remove it: `wicked-crew serve --uninstall-service`.

**Or start it by hand** each time with `wicked-crew serve`. It then logs to that terminal.

**On Windows (WSL2)**, the service needs wicked-crew 0.18.15 or later. Older releases wrote a unit that systemd rejects ("bad unit file setting"; [wicked-crew#1549](https://github.com/mikeparcewski/wicked-crew/issues/1549)). It also needs these:

- It needs systemd: `systemctl --user status` must not say "Failed to connect to bus". If it does, add these two lines to `/etc/wsl.conf`, then run `wsl --shutdown` in PowerShell and reopen Ubuntu:

  ```ini
  [boot]
  systemd=true
  ```

- To keep it running after you close the Ubuntu window, run `sudo loginctl enable-linger $USER` once.
- The service still runs only while the Ubuntu VM is running: open Ubuntu once after a Windows restart.

## Upgrading

1. Let running jobs finish or stop at a question.
2. Stop the daemon (Ctrl+C), or remove the service (`wicked-crew serve --uninstall-service`).
3. Upgrade crew and interactive together (they're released to work as a pair):

   ```bash
   npx -y wicked-installer@latest install wicked-crew wicked-interactive
   ```

4. Start it again with `wicked-crew serve`. If you use the login service, run `wicked-crew serve --install-service` instead.
5. Check the versions: `curl -s http://127.0.0.1:7701/api/v1/diagnostics` lists crew's under `components`.

Repositories and job history live in `~/.wicked-crew`, and Studio sign-ins live in the cluster. Both carry over an upgrade. Resetting Kubernetes in Rancher Desktop clears the sign-ins: sign in again under **Helpers**.

## Troubleshooting

| You see | Cause | Fix |
|---|---|---|
| Chat says "No helper is signed in yet" | Claude Code and Codex aren't signed in on this install | Studio → Helpers → sign in both |
| Installer says "kubectl is not installed" or "No local Kubernetes yet" | kubectl isn't on PATH | macOS: install Rancher Desktop and turn on Kubernetes. Windows: turn on WSL integration for Ubuntu-24.04 (Windows step 3) and reopen Ubuntu. Then run the installer again. |
| Installer says "no kubeconfig defines a local context (rancher-desktop or docker-desktop)" | Your kubeconfig has no `rancher-desktop` context | Check that `kubectl config get-contexts` lists `rancher-desktop`, then make `kubectl --context rancher-desktop get nodes` show `Ready` (Windows: copy the kubeconfig, step 5). Then run the installer again. |
| Installer says the kubelet "sets no pod process limit of 4096 or less" | `pod-max-pids` isn't set | Set it (macOS step 3, Windows step 4), restart Rancher Desktop, check the limit prints `4096`, then run the installer again |
| Installer says Kubernetes isn't ready, or jobs say "Kubernetes isn't running" | Rancher Desktop isn't running, or Kubernetes is off | Start it, enable Kubernetes, and check `kubectl --context rancher-desktop get nodes` shows `Ready`. On Windows, run that in Ubuntu. Still failing: see the fallbacks below. |
| Installer warns that Rancher Desktop runs the containerd engine | Container Engine is set to containerd | Preferences → Container Engine → dockerd (moby), then run the installer again |
| Jobs refused because an agent "did not arm" or a container couldn't start | Most often the cluster is short of memory, or the engine is containerd. The message names the cause. | Follow the message. For memory, give Rancher Desktop 8 GB or more; for the engine, use dockerd (moby). Restart it, then retry. |
| Windows: every verify gate denied | `WICKED_FLOOR_RUNNER=container` isn't set, or the checks container can't start | Run `source ~/.bashrc`, check `echo $WICKED_FLOOR_RUNNER` prints `container` and `command -v docker` finds docker, then restart the daemon. The gate's checks report says which it was. |
| Windows: `--install-service` fails with "bad unit file setting" | wicked-crew older than 0.18.15 ([wicked-crew#1549](https://github.com/mikeparcewski/wicked-crew/issues/1549)) | Stop the daemon, run [Upgrading](#upgrading) steps 1-3, then run `wicked-crew serve --uninstall-service` and `wicked-crew serve --install-service` |
| Windows: browser can't open http://localhost:7701 | The daemon isn't running in Ubuntu | Start `wicked-crew serve` in Ubuntu. If it still fails, try http://127.0.0.1:7701, or run `wsl --shutdown` in PowerShell, reopen Ubuntu, and start it again. |
| A sign-in page never finishes | The sign-in didn't open in your browser | Copy the sign-in link from the Helpers page into your browser |
| `npm` refuses wicked-crew, or a syntax error at start | Node older than 22.12 | `brew install node@22` (macOS) or `nvm install 22` (Windows), then check `node --version` |
| Delivery fails at the commit step | git has no name or email | `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then retry the deliver step |
| Delivery fails with a 403 when pushing | `gh` is signed in to a different GitHub account | Run `gh auth status` and sign in to an account with access. Then run `export GH_ACCOUNT="your-github-login"` (your login in place of `your-github-login`). For a hand-started daemon, stop it and run `wicked-crew serve` from that shell. For the login service, run `wicked-crew serve --install-service` from that shell to save the new environment. |

### Fallbacks when the containers won't work

Use these only if the main path can't run on your machine. Each one gives up isolation, so use them on a machine with nothing sensitive on it. Set the variables in the shell that starts the daemon, or in `~/.zshrc` / `~/.bashrc` (on Windows, remove the `WICKED_FLOOR_RUNNER=container` line from `~/.bashrc`), then restart it.

**1. Run the agents locally (no Kubernetes).** Agents run as ordinary processes on your machine, with your user's permissions.

```bash
export WICKED_SEAT_FLOOR=host
export WICKED_FLOOR_RUNNER=sandbox
export WICKED_CODEX_WORKTREE_OK=1
wicked-crew serve
```

- You give up container isolation. Only Claude Code and Codex can do governed work; Pi, Copilot and OpenCode are benched, which is expected. Building apps is refused. The installer's local Kubernetes line can stay pending.
- Sign-ins made for containers don't carry over. Check **Helpers** again and sign in any agent that shows signed out.
- `WICKED_CODEX_WORKTREE_OK=1` lets Codex work in repository worktrees on the host; without it Codex is benched for repository jobs.
- Repository checks run in the macOS sandbox on macOS. On Windows (WSL2) they need bubblewrap (`sudo apt install -y bubblewrap`), or fallback 2.

**2. Run repository checks without a sandbox.** If every verify gate is still denied because no sandbox is available:

```bash
export WICKED_FLOOR_RUNNER=sandbox
export WICKED_REPO_CHECKS_UNSANDBOXED=1
```

When no sandbox can start, the repository's own test and build scripts then run with no write boundary, as your user. The results are real, and every report and gate says the checks weren't sandboxed. Use it only with repositories whose scripts you trust.

### Where to look

- The daemon's log: the terminal you started `wicked-crew serve` in, or `~/.wicked-crew/daemon-stdout.log` when it runs as a service.
- `curl -s http://127.0.0.1:7701/api/v1/diagnostics` shows component versions, recent errors, the cluster and the skills status.

Send both when you report a problem. If you post them in a public issue, remove anything private first: names, paths, repository names, URLs and anything that looks like a credential.
