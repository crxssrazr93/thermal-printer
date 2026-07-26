# bluetooth connection frame for printer management

from typing import Optional, Callable, TYPE_CHECKING
import customtkinter as ctk

from ...core.printer import PrinterConnection, ConnectionState, BluetoothDevice
from ...config.keys import SettingsKeys
from ...config.settings import get_settings
from ...utils.validators import validate_mac_address, normalize_mac_address
from ..widgets.flow_frame import FlowFrame

TRANSPORT_BLUETOOTH = "Bluetooth"
TRANSPORT_USB = "USB"
TRANSPORT_CUPS = "CUPS"

if TYPE_CHECKING:
    from ...interfaces import SettingsService


class ConnectionFrame(ctk.CTkFrame):

    def __init__(
        self,
        master,
        printer: PrinterConnection,
        on_scan_request: Optional[Callable] = None,
        on_status_change: Optional[Callable[[str], None]] = None,
        on_bluetooth_check: Optional[Callable[[], bool]] = None,
        settings_service: Optional["SettingsService"] = None,
        **kwargs
    ):
        super().__init__(master, **kwargs)

        self.printer = printer
        self.on_scan_request = on_scan_request
        self.on_status_change = on_status_change
        self.on_bluetooth_check = on_bluetooth_check

        self._settings = settings_service if settings_service else get_settings()
        self._setup_ui()
        self._load_settings()

        self.printer.add_state_callback(self._on_connection_state_change)

    def _setup_ui(self) -> None:
        label_font = ctk.CTkFont(size=15, weight="bold")
        entry_font = ctk.CTkFont(size=14)
        btn_font = ctk.CTkFont(size=14)
        status_font = ctk.CTkFont(size=15, weight="bold")

        # single row with printer label mac entry buttons and status
        row = FlowFrame(self)
        row.pack(fill="x", padx=12, pady=10)

        row.add(ctk.CTkLabel(
            row, text="Link:",
            font=label_font
        ), gap=6)

        self.transport_var = ctk.StringVar(value=TRANSPORT_BLUETOOTH)
        self.transport_dropdown = ctk.CTkOptionMenu(
            row,
            values=[TRANSPORT_BLUETOOTH, TRANSPORT_USB, TRANSPORT_CUPS],
            variable=self.transport_var,
            width=110, height=36,
            font=entry_font,
            dynamic_resizing=False,
            command=self._on_transport_change
        )
        row.add(self.transport_dropdown, gap=12)

        self.mac_label = ctk.CTkLabel(row, text="MAC:", font=label_font)
        row.add(self.mac_label, gap=10)

        self.mac_entry = ctk.CTkEntry(
            row, placeholder_text="XX:XX:XX:XX:XX:XX",
            width=180, height=36,
            font=entry_font
        )
        row.add(self.mac_entry, gap=12)

        btn_width = 100
        btn_height = 36

        self.scan_button = ctk.CTkButton(
            row, text="Scan",
            width=btn_width, height=btn_height,
            font=btn_font,
            command=self._on_scan_click
        )
        row.add(self.scan_button, gap=8)

        self.connect_button = ctk.CTkButton(
            row, text="Connect",
            width=btn_width, height=btn_height,
            font=btn_font,
            command=self._on_connect_click
        )
        row.add(self.connect_button, gap=8)

        self.disconnect_button = ctk.CTkButton(
            row, text="Disconnect",
            width=btn_width, height=btn_height,
            font=btn_font,
            state="disabled",
            command=self._on_disconnect_click
        )
        row.add(self.disconnect_button, gap=12)

        # device name label (next to disconnect button)
        self.printer_label = ctk.CTkLabel(
            row, text="Printer:",
            font=label_font,
            text_color=("gray50", "gray50")
        )
        row.add_trailing(self.printer_label, gap=4)

        self.device_name_label = ctk.CTkLabel(
            row, text="--",
            font=entry_font,
            text_color=("gray50", "gray50")
        )
        row.add_trailing(self.device_name_label, gap=15)

        self.status_label = ctk.CTkLabel(
            row, text="\u25cb  Disconnected",
            font=status_font,
            text_color=("gray50", "gray50")
        )
        row.add_trailing(self.status_label, gap=0)

    def _load_settings(self) -> None:
        mac = self._settings.get(SettingsKeys.Printer.MAC_ADDRESS, "")
        if mac:
            self.mac_entry.insert(0, mac)

        device_name = self._settings.get(SettingsKeys.Printer.DEVICE_NAME, "")
        self._update_device_name(device_name)

    def _update_device_name(self, name: str) -> None:
        if name:
            self.device_name_label.configure(text=name)
        else:
            self.device_name_label.configure(text="--")

    def _save_settings(self, mac: str, device_name: str = "") -> None:
        self._settings.set(SettingsKeys.Printer.MAC_ADDRESS, mac)
        self._settings.set(SettingsKeys.Printer.DEVICE_NAME, device_name)
        self._settings.save()

    def _on_scan_click(self) -> None:
        mode = self.transport_var.get()

        if mode == TRANSPORT_USB:
            devices = self.printer.list_usb_devices()
            if not devices:
                self._show_error(
                    "No USB printer found at /dev/usb/lp*.\n\n"
                    "Check the cable and power, and that your user is in the 'lp' group."
                )
                return
            self.mac_entry.delete(0, "end")
            self.mac_entry.insert(0, devices[0])
            self._set_status(f"Found {len(devices)} USB printer(s): {devices[0]}")
            return

        if mode == TRANSPORT_CUPS:
            queues = self.printer.list_cups_destinations()
            if not queues:
                self._show_error("No CUPS queues found. Is cups running?")
                return
            self.mac_entry.delete(0, "end")
            self.mac_entry.insert(0, queues[0])
            self._set_status(f"Found {len(queues)} queue(s): {', '.join(queues)}")
            return

        if self.on_scan_request:
            self.on_scan_request()

    def _on_transport_change(self, value=None) -> None:
        """Bluetooth needs a MAC; the wired transports take a device or queue."""
        mode = self.transport_var.get()

        if mode == TRANSPORT_BLUETOOTH:
            self.mac_label.configure(text="MAC:")
            self.mac_entry.configure(placeholder_text="XX:XX:XX:XX:XX:XX")
            self.scan_button.configure(state="normal", text="Scan")
        elif mode == TRANSPORT_USB:
            self.mac_label.configure(text="Device:")
            self.mac_entry.configure(placeholder_text="auto (/dev/usb/lp0)")
            self.scan_button.configure(state="normal", text="Detect")
        else:
            self.mac_label.configure(text="Queue:")
            self.mac_entry.configure(placeholder_text="CUPS queue name")
            self.scan_button.configure(state="normal", text="Detect")

        self._set_status(f"Link: {mode}")

    def _connect_wired(self, mode: str) -> None:
        target = self.mac_entry.get().strip()

        self.connect_button.configure(state="disabled")
        self.scan_button.configure(state="disabled")
        self._set_status("Connecting...")

        try:
            if mode == TRANSPORT_USB:
                self.printer.connect_usb(target or None)
            else:
                if not target:
                    raise ValueError("Enter a CUPS queue name, or press Detect")
                self.printer.connect_cups(target)
        except Exception as e:
            self._show_error(str(e))
            self.connect_button.configure(state="normal")
            self.scan_button.configure(state="normal")

    def _on_connect_click(self) -> None:
        mode = self.transport_var.get()
        if mode != TRANSPORT_BLUETOOTH:
            self._connect_wired(mode)
            return

        if self.on_bluetooth_check and not self.on_bluetooth_check():
            return

        mac = self.mac_entry.get().strip()

        is_valid, error = validate_mac_address(mac)
        if not is_valid:
            self._show_error(error or "Invalid MAC address")
            return

        mac = normalize_mac_address(mac)
        self.mac_entry.delete(0, "end")
        self.mac_entry.insert(0, mac)

        self.connect_button.configure(state="disabled")
        self.scan_button.configure(state="disabled")
        self._set_status("Connecting...")

        try:
            device_name = self._settings.get(SettingsKeys.Printer.DEVICE_NAME, "")
            self.printer.connect(mac, device_name)
            self._save_settings(mac, device_name)
        except Exception as e:
            self._show_error(str(e))
            self.connect_button.configure(state="normal")
            self.scan_button.configure(state="normal")

    def _on_disconnect_click(self) -> None:
        self.disconnect_button.configure(state="disabled")
        self._set_status("Disconnecting...")

        try:
            self.printer.disconnect()
        except Exception as e:
            self._show_error(str(e))
        finally:
            self.disconnect_button.configure(state="normal")

    def _on_connection_state_change(self, state: ConnectionState) -> None:
        # connection state changes control ui button states and visual feedback
        # connected state disables connection controls and enables disconnect
        # disconnected and error states reset to allow new connection attempts
        if state == ConnectionState.CONNECTED:
            self.connect_button.configure(state="disabled")
            self.disconnect_button.configure(state="normal")
            self.scan_button.configure(state="disabled")
            self.mac_entry.configure(state="disabled")

            device_name = self.printer.device_name or ""
            self._update_device_name(device_name)
            self.device_name_label.configure(text_color=("green", "#00CC00"))
            self.status_label.configure(
                text="\u25cf  Connected",
                text_color=("green", "#00CC00")
            )
            self._set_status("Connected to printer")

        elif state == ConnectionState.CONNECTING:
            self.status_label.configure(
                text="\u25d0  Connecting\u2026",
                text_color=("orange", "#FFAA00")
            )

        elif state == ConnectionState.DISCONNECTED:
            self.connect_button.configure(state="normal")
            self.disconnect_button.configure(state="disabled")
            self.scan_button.configure(state="normal")
            self.mac_entry.configure(state="normal")

            self.device_name_label.configure(text_color=("gray50", "gray50"))
            self.status_label.configure(
                text="\u25cb  Disconnected",
                text_color=("gray50", "gray50")
            )
            self._set_status("Disconnected")

        elif state == ConnectionState.ERROR:
            self.connect_button.configure(state="normal")
            self.disconnect_button.configure(state="disabled")
            self.scan_button.configure(state="normal")
            self.mac_entry.configure(state="normal")

            self.device_name_label.configure(text_color=("red", "#FF4444"))
            self.status_label.configure(
                text="\u26a0  Error",
                text_color=("red", "#FF4444")
            )

    def _set_status(self, message: str) -> None:
        if self.on_status_change:
            self.on_status_change(message)

    def _show_error(self, message: str) -> None:
        self._set_status(f"Error: {message}")
        self.status_label.configure(
            text="\u26a0  Error",
            text_color=("red", "#FF4444")
        )

    def set_device(self, device: BluetoothDevice) -> None:
        self.mac_entry.delete(0, "end")
        self.mac_entry.insert(0, device.mac_address)
        self._update_device_name(device.name)
        self._settings.set(SettingsKeys.Printer.DEVICE_NAME, device.name)

    def destroy(self) -> None:
        self.printer.remove_state_callback(self._on_connection_state_change)
        super().destroy()
