# Troubleshooting

## It will not connect

- Is the printer on, and is it paired? `bluetoothctl devices` lists what the
  machine knows about.
- Is anything else connected to it? These printers accept one connection at a
  time, so a phone that grabbed it first will hold it.
- `systemctl status bluetooth` for the daemon, and `bluetoothctl power on` if
  the adapter is off.
- After a failed print the printer can be left mid-job and stop responding.
  Power cycle it, then connect again.

## It prints streaks, or garbage after the first few lines

That was a real bug, fixed by sending the page a band at a time and writing
every band in full. If you see it on a build that has that fix, the printer is
probably being fed by something else at the same time, or the battery is low
enough that the head is browning out.

## Permission denied on USB

Your user needs to be in the group that owns the device node:

```bash
ls -l /dev/usb/lp0          # look at the group
sudo usermod -aG lp $USER   # then log out and back in
```

## Nothing happens when I press Print

Check the connection light in the top right of the window. If it says
Disconnected, the button did nothing because there was nothing to print to.
`journalctl --user -u thermal-print-studio -f` shows what the server thought.

## The preview is fine but the paper is not

- **Too light or too dark**: Darkness in Settings, and for pictures the Cutoff
  slider.
- **Cut off down one side**: the paper is 384 dots wide and that is the whole
  page; anything wider is not scaled, it is lost. Reduce the type size.
- **Cut off along the roll**: a strip is only as deep as the head is wide, and
  the preview warns when a page is deeper than that.

## A symbol prints as a box

The paper font does not carry that glyph. Change the font in Settings, or
install one with wider coverage: DejaVu Sans Mono and Noto Sans Mono between
them cover most of what the symbol picker offers. The preview is honest about
this, so if it shows a box, so will the paper.

## Arabic or Hebrew prints as separate letters

The text is not being shaped, which means Pillow was built without RAQM. Check
with:

```python
from PIL import features; print(features.check('raqm'))
```

If that says False, install `libraqm` and reinstall Pillow.

## The service will not start

```bash
systemctl --user status thermal-print-studio
journalctl --user -u thermal-print-studio -n 50
```

The usual causes are a port already in use (something else on 8760) and a
`~/.local/bin` that is not on PATH for the unit.

## My presets disappeared

They live in `~/.local/share/thermal-printer/presets.json`, which nothing in
the install or uninstall touches. If the file is there, the server is probably
reading a different data directory: check `THERMAL_DATA_DIR` in the unit.
