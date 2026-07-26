# Installing

## The short version

```bash
git clone https://github.com/crxssrazr93/thermal-print-studio.git
cd thermal-print-studio
./install.sh
```

`install.sh` installs the app for your user with whichever of `uv`, `pipx` or
`pip` it finds, writes a systemd **user** service, enables it and starts it.
When it finishes, the app is at

**<http://127.0.0.1:8760>**

and it comes back on its own after a reboot.

## Why a user service, not a system one

The printer is paired to your Bluetooth session and your presets live in your
home directory. A root service would reach neither. The trade is that it starts
when you log in, so to keep it running on a machine nobody is logged into:

```bash
sudo loginctl enable-linger $USER
```

## As an app rather than a tab

Chrome and Edge offer **Install** in the address bar. That gives the app its own
window, its own icon and no browser chrome, and it stays up to date with the
server without anything being packaged or signed. Firefox has no equivalent, so
a pinned tab is the closest thing there.

## From your phone, or another machine

The server listens on localhost only, so nothing outside this machine can print
without being invited. **Settings, under Network**, has the switch: tick it and
the server starts listening on every interface, and Settings shows the address
to use. The listening socket is swapped rather than the app restarted, so
nothing is interrupted.

Then use `http://<this machine>:8760` from anything on the same network, and
install it there too. **There is no authentication**: whoever can reach it can
print, spend your paper and read your presets. Put it on a network you trust,
turn it off again when you are done, or leave it local and reach it through SSH
forwarding.

To decide it outside the app, set `THERMAL_WEB_HOST` in the unit, which then
wins and greys the switch out:

```bash
systemctl --user edit --full thermal-print-studio   # set THERMAL_WEB_HOST=0.0.0.0
systemctl --user restart thermal-print-studio
```

## Managing it

```bash
systemctl --user status thermal-print-studio     # is it running
systemctl --user restart thermal-print-studio    # after changing the unit
journalctl --user -u thermal-print-studio -f     # what it is doing
```

## Updating

```bash
git pull
./install.sh          # reinstalls and restarts the service
```

## Removing it

```bash
./uninstall.sh
```

That stops and removes the service and uninstalls the package. Your presets,
to-dos, pictures and themes in `~/.local/share/thermal-printer/` are left alone,
as is `config.yaml`.

## Without systemd

`./install.sh` still installs the package; run `thermal-print-studio` yourself,
or `./web/run-web.sh` from a checkout. Any supervisor that can run a command
will do: the server is a single process with no state of its own beyond those
two directories.

## System packages

The app itself needs only Python and the three libraries in `pyproject.toml`.
The Bluetooth transport needs BlueZ, which is what provides `bluetoothctl`:

```bash
sudo pacman -S bluez bluez-utils       # Arch, CachyOS
sudo apt install bluez                 # Debian, Ubuntu
sudo dnf install bluez                 # Fedora, RHEL
```

For USB, your user needs to be in the group that owns `/dev/usb/lp0`, which is
`lp` on most distributions:

```bash
sudo usermod -aG lp $USER              # then log out and back in
```

Fonts are whatever your system has. Mono faces with wide coverage are worth
having, since the paper font is the one that decides whether a symbol prints:

```bash
sudo pacman -S ttf-dejavu noto-fonts   # Arch, CachyOS
sudo apt install fonts-dejavu fonts-noto-mono
sudo dnf install dejavu-sans-mono-fonts google-noto-sans-mono-fonts
```
