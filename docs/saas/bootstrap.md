# Server bootstrap

This guide prepares a new Ubuntu 24.04 LTS server for MSCD SaaS. It covers what to buy and set up at the provider, the DNS records, the bootstrap run from GitHub Actions, and what to do afterwards. The script behind it is `deploy/scripts/bootstrap-host.sh`; the workflow is `.github/workflows/bootstrap-prod.yml`.

Do the staging server first, then the production server, with the same steps.

## What the bootstrap does

The script runs as root, step by step. Each step first compares the server with the target state and then reports one of three results: `done` (already in place), `changed` or `skipped`. Running it again is safe.

| Step | What it sets up |
|---|---|
| Data volume | With `--data-device`, mounts the block volume at `/var/lib/docker`, so Docker volumes and container logs live there. Docker starts only when the volume is mounted |
| System packages | `apt-get upgrade`, then the base packages: OpenSSH server, rsync, curl, ufw, fail2ban, chrony and unattended-upgrades |
| Docker Engine | Docker CE and the Compose plugin from Docker's own apt repository (signing key checked against its fingerprint `9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88`). `/etc/docker/daemon.json` turns on `live-restore` (containers keep running while Docker restarts), the `local` log driver and address pools outside `172.31.0.0/16` |
| Time, swap and journal | Time zone UTC with chrony, a 4 GB swap file with `vm.swappiness = 10`, and a system journal of at most 1 GB |
| Accounts | `deploy` for GitHub Actions (SSH key only, member of the `docker` group, no sudo), one admin account for the owner (SSH key only, sudo), and the `mscd` system account |
| Folders | `/opt/mscd` and its folders for releases, state, logs, secrets, backups and metrics |
| Security updates | Daily Ubuntu security updates without automatic reboot, and a reboot-needed marker for the monitoring |
| Firewall | ufw denies everything that comes in, except SSH (rate limited), HTTP and HTTPS. fail2ban bans addresses that keep failing SSH logins |
| SSH | Key-only logins for `deploy` and the admin account. Root and password logins are turned off |

At the end the script prints the fingerprints of the server's SSH host keys and the lines for the secret `DEPLOY_SSH_KNOWN_HOSTS`.

## Before you start

### At the provider

1. Create the server: Ubuntu 24.04 LTS, 4 vCPU or more, 16 GB RAM, 80 GB system disk (staging: 8 GB RAM is enough). Choose the location decided in K.3 of the plan (D-S2).
2. Attach a block volume of 200 GB or more for the Docker data. Leave it empty: do not format or mount it in the provider's panel. Note the device name the provider shows, for example `/dev/sdb` or `/dev/vdb`. A path under `/dev/disk/by-id/` also works and stays the same after a reboot.
3. Turn on IPv6 if the provider offers it.
4. Make a key pair just for the bootstrap on your own computer and give its public half to the provider as the root SSH key:

   ```bash
   ssh-keygen -t ed25519 -N '' -C mscd-bootstrap -f mscd-bootstrap-staging
   ```

5. If the provider has its own firewall, allow 22/tcp, 80/tcp, 443/tcp and 443/udp. The server's own firewall covers the rest.
6. Start the server and open its console in the provider's panel. Copy the SHA256 fingerprint of the ED25519 host key. Most providers show it in the console log of the first boot. Otherwise, sign in on the web console and run:

   ```bash
   ssh-keygen -l -E sha256 -f /etc/ssh/ssh_host_ed25519_key.pub
   ```

   The fingerprint looks like `SHA256:` followed by 43 letters, digits, `+` and `/`. The workflow uses it to make sure it talks to your server.

### Keys on your own computer

Make two more key pairs. Keep the private halves in your password manager.

```bash
# The deploy key: GitHub Actions signs in with it as "deploy"
ssh-keygen -t ed25519 -N '' -C mscd-deploy-staging -f mscd-deploy-staging
```

For the admin account, use your own personal key (for example `~/.ssh/id_ed25519.pub`). The admin key, the deploy key and the bootstrap key must be three different keys. The workflow refuses the run when two of them are the same.

### In GitHub

In Settings, Environments, `staging` (later `production`), add two secrets:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | The server's public IPv4 address or host name |
| `BOOTSTRAP_SSH_KEY` | The private half of the bootstrap key (the file `mscd-bootstrap-staging`) |

```bash
gh secret set DEPLOY_HOST --env staging --body 203.0.113.10
gh secret set BOOTSTRAP_SSH_KEY --env staging < mscd-bootstrap-staging
```

### DNS records

Add these records at your DNS provider before the first deploy. Caddy needs them to get the certificate from Let's Encrypt.

| Name | Type | Value |
|---|---|---|
| `app.<domain>` | A | the server's IPv4 address |
| `app.<domain>` | AAAA | the server's IPv6 address (when the provider gives one) |
| `<domain>` | CAA | `0 issue "letsencrypt.org"` |
| `ops.<domain>` (optional) | A and AAAA | the same addresses, for the Grafana dashboards |

A CAA record says which certificate authority may issue certificates for the domain. With the record above, only Let's Encrypt may.

## Run the bootstrap

Start the workflow from the Actions tab (Bootstrap server, Run workflow) or with `gh`:

```bash
gh workflow run bootstrap-prod.yml \
  -f target=staging \
  -f admin_user=owner \
  -f admin_public_key="$(cat ~/.ssh/id_ed25519.pub)" \
  -f deploy_public_key="$(cat mscd-deploy-staging.pub)" \
  -f host_key_fingerprint=SHA256:paste-the-fingerprint-here \
  -f data_device=/dev/sdb \
  -f format_data_device=true
```

| Input | Meaning |
|---|---|
| `target` | `staging` or `production`. It picks the GitHub environment with its secrets and approval rule |
| `admin_user` | Name of your admin account on the server. Lower-case letters, digits, `-` and `_`. Not `root`, `deploy` or `mscd` |
| `admin_public_key` | Your own SSH public key, one line |
| `deploy_public_key` | The public half of the deploy key, one line |
| `host_key_fingerprint` | The SHA256 fingerprint from the provider console |
| `data_device` | The block volume, or empty for none |
| `format_data_device` | `true` formats the block volume as ext4. The script formats only a device that is completely empty |

An agent may start this workflow only when you ask for it. The job then waits until you approve the environment in GitHub.

The run does this:

1. It checks the inputs and the two secrets.
2. It reads the server's host keys with `ssh-keyscan` and compares them with your fingerprint. When none matches, it stops before it signs in. This protects against a wrong address and against a machine in between.
3. It opens one SSH connection as root with the bootstrap key and the pinned host key.
4. It copies the script and its configuration files to `/root/mscd-bootstrap` and runs the script.
5. Over the same connection it reads the host key lines that the script saved, and writes the job summary.
6. It closes the connection and deletes the key from the runner.

The script turns root logins off at its end. That is why the workflow can run only once per server. Later runs of the script are made by you, as described in [Run it again or check the server](#run-it-again-or-check-the-server).

### After the run

The job summary lists the next steps. Do them right away:

1. Delete the bootstrap key. Nothing needs root access over SSH any more. Also delete the private key file on your computer.

   ```bash
   gh secret delete BOOTSTRAP_SSH_KEY --env staging
   ```

2. Copy the lines under DEPLOY_SSH_KNOWN_HOSTS in the summary into a file `known_hosts` and save them as a secret. Each line starts with a hash of the server address, so the summary does not show the address. `ssh` reads these lines like plain ones.

   ```bash
   gh secret set DEPLOY_SSH_KNOWN_HOSTS --env staging < known_hosts
   ```

3. Save the private half of the deploy key, the deploy account and the SSH port:

   ```bash
   gh secret set DEPLOY_SSH_KEY --env staging < mscd-deploy-staging
   gh secret set DEPLOY_USER --env staging --body deploy
   gh variable set DEPLOY_SSH_PORT --env staging --body 22
   ```

4. When the summary says that updates need a reboot, sign in and reboot: `ssh owner@<server>`, then `sudo reboot`.
5. Sign in once as the admin account to confirm that your key works: `ssh owner@<server>`.

## Data volume

The script mounts the block volume at `/var/lib/docker` with a systemd mount unit (`/etc/systemd/system/var-lib-docker.mount`) that names the volume by its file system UUID. A drop-in for `docker.service` makes Docker wait for the mount. When the volume is missing at boot, the server still starts and SSH works, and Docker stays stopped, so a deploy can never start on an empty system disk by mistake.

- `--format-data-device` formats the device as ext4 only when it is empty: no partitions, no file system or other signature, and only zeros in its first megabyte. Any other device stops the script with a message and stays as it is.
- A device that already has an ext4 or XFS file system is mounted as it is, for example a volume moved from an old server.
- With Docker 29 the images and container layers live in `/var/lib/containerd` on the system disk (a few GB per release). The large data, the Docker volumes of PostgreSQL, the object store, Caddy and the monitoring, sits on the block volume.

To move existing Docker data from the system disk to a new volume later, stop the stack and Docker, copy `/var/lib/docker` to the formatted volume (for example with `rsync -aHAX`), empty `/var/lib/docker`, then run the script with `--data-device` without `--format-data-device`. The script refuses to mount over a non-empty `/var/lib/docker`.

## Ports and the firewall

The firewall (ufw) denies everything that comes in except these ports:

| Port | Why |
|---|---|
| 22/tcp | SSH. ufw refuses the 6th new connection from one address within 30 seconds, so at most 5 are allowed |
| 80/tcp | HTTP for the certificate checks of Let's Encrypt and the redirect to HTTPS |
| 443/tcp | HTTPS |
| 443/udp | HTTP/3 |

Outgoing connections are allowed. Rules that someone added by hand stay in place, and the script lists them as a warning.

**Docker-published ports bypass ufw.** Docker writes its own firewall rules for every port that a container publishes, and these rules come before the ufw rules. A port published by any container is open to the internet whatever ufw says. That is why only the Caddy container publishes ports (80 and 443) in the SaaS stack, and every other service (PostgreSQL, the object store, the API, the monitoring) is reachable only on the internal Docker networks. Never add a `ports:` entry to another service. To see which ports are open:

```bash
sudo docker ps --format '{{.Names}}\t{{.Ports}}'
sudo ss -tlnup
```

fail2ban watches the SSH logins: an address with 5 failed logins within 10 minutes is banned for 1 hour, and each new ban of the same address lasts longer, up to one week. To see and lift bans:

```bash
sudo fail2ban-client status sshd
sudo fail2ban-client set sshd unbanip 198.51.100.7
```

Because of the SSH rate limit, workflows that sign in as `deploy` keep one SSH connection open for all their commands, as `bootstrap-prod.yml` does.

## Accounts and SSH access

| Account | Signs in with | Rights |
|---|---|---|
| your admin account | your own SSH key | sudo without a password. The account has no password at all |
| `deploy` | the deploy key, from GitHub Actions only | member of `docker`, no sudo. Its key carries `restrict`: no terminal, no port forwarding |
| `mscd` | cannot sign in | system account for the containers |
| `root` | cannot sign in over SSH | use `sudo` from the admin account |

Membership of the `docker` group gives full control of the server, so the deploy key deserves the same care as a root key.

The SSH settings are in `/etc/ssh/sshd_config.d/10-mscd.conf`. They allow only `deploy` and the admin account, only with keys, and turn off forwarding. Before it turns root and password logins off, the script checks that both accounts have a key, so you cannot lock yourself out with it.

To require your password for sudo, set one and remove the file that allows sudo without it:

```bash
sudo passwd owner
sudo rm /etc/sudoers.d/90-mscd-admin
```

The next run of the script puts that file back, so run it with `--only` and leave out `accounts` from then on, or keep the file.

If you are locked out, use the web console of the provider. It works without SSH.

## Security updates and reboots

unattended-upgrades installs the Ubuntu security updates every day. It never reboots the server. Docker Engine is updated only by hand, in the maintenance window (Sunday 22:00 to 24:00 WIB, which is 15:00 to 17:00 UTC).

When an update needs a reboot, Ubuntu creates `/run/reboot-required`. A timer (`mscd-reboot-marker.timer`) checks every 15 minutes and writes `/opt/mscd/metrics/reboot.prom` for the monitoring:

- `mscd_host_reboot_required` is 1 when a reboot is needed;
- `mscd_host_reboot_required_since_timestamp_seconds` tells since when.

Reboot in the maintenance window. Containers start again by themselves.

## Folders

| Folder | Mode | Content |
|---|---|---|
| `/opt/mscd` | 0755 | the installation, with `.env` written by the deploy script |
| `/opt/mscd/releases` | 0755 | one folder per release version |
| `/opt/mscd/state` | 0750 | current and previous image digests, the saved host key lines |
| `/opt/mscd/logs` | 0750 | migration logs |
| `/opt/mscd/secrets` | 0700 | keys and passwords of the stack |
| `/opt/mscd/backup` | 0700 | database dumps taken before each deploy |
| `/opt/mscd/metrics` | 0755 | text files for the monitoring (node exporter) |

All of them belong to `deploy`. The secret files inside have their own owners and modes, set by the deploy script.

## Run it again or check the server

The workflow runs only on a new server. Afterwards, sign in as the admin account and run the script with sudo from a copy of the repository or from `/root/mscd-bootstrap`, which the workflow left on the server:

```bash
sudo bash /root/mscd-bootstrap/scripts/bootstrap-host.sh --admin-user owner \
  --deploy-key-file /root/mscd-bootstrap/keys/deploy.pub --check
```

| Option | Use |
|---|---|
| `--check` | Reports every difference from the target state and exits 1 when there is one. Changes nothing. Waiting package updates are reported as information |
| `--dry-run` | Prints each command a real run would make. Changes nothing |
| `--render-only --root DIR` | Writes every configuration file under DIR. Changes nothing else |
| `--only STEP,...` | Runs only the named steps: `data-volume`, `packages`, `docker`, `system`, `accounts`, `folders`, `updates`, `firewall`, `ssh` |
| `--skip-upgrade` | Leaves out `apt-get upgrade`, for example on a live server outside the maintenance window |
| `--admin-key-file FILE` | Adds these keys to the admin account. Keys already there stay |
| `--ssh-host NAME` | Name or address at the start of the known_hosts lines |

A real run on a live server is safe: Docker restarts only when `daemon.json` changed, and running containers keep running during that restart because of `live-restore`. Run it in the maintenance window anyway, because `apt-get upgrade` may restart services. The log of each run is in `/var/log/mscd-bootstrap.log`.

To replace the deploy key, run the script with the new public key in `--deploy-key-file`. The old key stops working at once. Then update `DEPLOY_SSH_KEY` in GitHub.

## Later: close port 22 with Tailscale

Port 22 stays open to the internet at first, because the addresses of the GitHub runners change all the time and cannot be listed in the firewall. Key-only logins, the rate limit and fail2ban protect it meanwhile. To close it later:

1. Create a Tailscale account (tailnet) with an ACL that allows the tag `tag:mscd-ci` to reach the servers on port 22, and an OAuth client for that tag.
2. Install Tailscale on the server, join the tailnet with a tag such as `tag:mscd-server`, and confirm that you reach the server over its Tailscale address.
3. Add the step `tailscale/github-action` (pinned to a full commit SHA) at the start of every workflow that uses SSH, with the OAuth client in the environment secrets, and use the Tailscale name of the server in `DEPLOY_HOST` and in `DEPLOY_SSH_KNOWN_HOSTS`.
4. Allow SSH on the Tailscale interface and remove the public rule:

   ```bash
   sudo ufw allow in on tailscale0 to any port 22 proto tcp
   sudo ufw delete limit 22/tcp
   ```

5. Change the rule file `deploy/host/firewall/ufw-rules` in the same way, so the next run of the script does not open the port again.

Keep the provider's web console as the way in when Tailscale is down.
