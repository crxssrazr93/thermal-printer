# bluetooth connection frame for printer management

from typing import Optional, Callable, TYPE_CHECKING
import customtkinter as ctk

from ...core.printer import PrinterConnection, ConnectionState, BluetoothDevice
from ...config.keys import SettingsKeys
from ...config.settings import get_settings
from ...utils.validators import validate_mac_address, normalize_mac_address
from ..widgets.flow_frame import FlowFrame
from ...core import device_profiles as saved_profiles
from ..dialogs.device_profile_dialog import DeviceProfileDialog

TRANSPORT_BLUETOOTH = "Bluetooth"
TRANSPORT_USB = "USB"
TRANSPORT_CUPS = "CUPS"

NEW_PROFILE_LABEL = "+  Create profile..."

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
        # label -> connect value for the currently listed transport
        self._device_map = {}
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
            row, text="Printer:",
            font=label_font
        ), gap=6)

        self.profile_var = ctk.StringVar(value="")
        self.profile_dropdown = ctk.CTkOptionMenu(
            row,
            values=[NEW_PROFILE_LABEL],
            variable=self.profile_var,
            width=250, height=36,
            font=entry_font,
            dynamic_resizing=False,
            command=self._on_profile_selected
        )
        row.add(self.profile_dropdown, gap=8)

        self.edit_profile_button = ctk.CTkButton(
            row, text="Edit", width=64, height=36,
            font=entry_font,
            command=self._edit_profile
        )
        row.add(self.edit_profile_button, gap=12)

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
        self._refresh_profiles()

    # -------------------------------------------------------------------------
    # saved device profiles
    # -------------------------------------------------------------------------
    def _refresh_profiles(self, select: str = "") -> None:
        names = saved_profiles.get_profile_names()
        values = names + [NEW_PROFILE_LABEL]
        self.profile_dropdown.configure(values=values)

        target = select or saved_profiles.get_active_name()
        if target not in names:
            target = names[0] if names else NEW_PROFILE_LABEL

        self.profile_var.set(target)
        if target in names:
            saved_profiles.set_active(target)

        self._update_profile_summary()

    def _update_profile_summary(self) -> None:
        profile = saved_profiles.find_profile(self.profile_var.get())
        has_profile = profile is not None

        self.edit_profile_button.configure(state="normal" if has_profile else "disabled")
        self.connect_button.configure(
            state="normal" if has_profile and not self.printer.is_connected else "disabled"
        )

        if profile:
            self._update_device_name(profile["name"])
            self._set_status(f"{profile['transport']} - {profile['address']}")
        else:
            self._update_device_name("--")

    def _on_profile_selected(self, value: str = "") -> None:
        if value == NEW_PROFILE_LABEL:
            self._create_profile()
            return
        saved_profiles.set_active(value)
        self._update_profile_summary()

    def _create_profile(self) -> None:
        dialog = DeviceProfileDialog(self)
        self.wait_window(dialog)
        self._refresh_profiles(select=dialog.saved_name or "")

    def _edit_profile(self) -> None:
        name = self.profile_var.get()
        if not saved_profiles.find_profile(name):
            return
        dialog = DeviceProfileDialog(self, edit_name=name)
        self.wait_window(dialog)
        self._refresh_profiles(select=dialog.saved_name or "")

    # -------------------------------------------------------------------------
    # connect
    # -------------------------------------------------------------------------
    def _on_scan_click(self) -> None:
        self._refresh_profiles()
        self._set_status("Profile list refreshed")

    def _on_connect_click(self) -> None:
        profile = saved_profiles.find_profile(self.profile_var.get())
        if profile is None:
            self._show_error("Create a device profile first")
            return

        transport = profile.get("transport", TRANSPORT_BLUETOOTH)
        address = profile.get("address", "")

        # the capability profile travels with the device, so selecting a
        # printer also selects its width and feature set
        capability = profile.get("capability_profile")
        if capability:
            self._settings.set(SettingsKeys.Printer.PROFILE, capability)

        self.connect_button.configure(state="disabled")
        self.scan_button.configure(state="disabled")
        self._set_status(f"Connecting to {profile['name']}...")

        try:
            if transport == TRANSPORT_USB:
                self.printer.connect_usb(address or None)
            elif transport == TRANSPORT_CUPS:
                self.printer.connect_cups(address)
            else:
                if self.on_bluetooth_check and not self.on_bluetooth_check():
                    raise ValueError("Bluetooth is off")
                is_valid, error = validate_mac_address(address)
                if not is_valid:
                    raise ValueError(error or "Invalid MAC address")
                self.printer.connect(normalize_mac_address(address), profile["name"])
        except Exception as error:
            self._show_error(str(error))
            self.connect_button.configure(state="normal")
            self.scan_button.configure(state="normal")

    def _on_disconnect_click(self) -> None:
        try:
            self.printer.disconnect()
        except Exception as error:
            self._show_error(str(error))

    def _update_device_name(self, name: str) -> None:
        if name:
            self.device_name_label.configure(text=name)
        else:
            self.device_name_label.configure(text="--")

    def _on_connection_state_change(self, state: ConnectionState) -> None:
        # connection state changes control ui button states and visual feedback
        # connected state disables connection controls and enables disconnect
        # disconnected and error states reset to allow new connection attempts
        if state == ConnectionState.CONNECTED:
            self.connect_button.configure(state="disabled")
            self.disconnect_button.configure(state="normal")
            self.scan_button.configure(state="disabled")
            self.profile_dropdown.configure(state="disabled")
            self.edit_profile_button.configure(state="disabled")

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
            self.profile_dropdown.configure(state="normal")
            self.edit_profile_button.configure(state="normal")

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
            self.profile_dropdown.configure(state="normal")
            self.edit_profile_button.configure(state="normal")

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
        """Called when a device is picked from the scanner dialog.

        A scanned device is not yet a profile, so store it as one - otherwise
        the choice would be lost the moment the dialog closed.
        """
        name = saved_profiles.save_profile(
            name=device.name or device.mac_address,
            transport=TRANSPORT_BLUETOOTH,
            address=device.mac_address,
            capability_profile=self._settings.get(SettingsKeys.Printer.PROFILE, ""),
        )
        self._refresh_profiles(select=name)

    def destroy(self) -> None:
        self.printer.remove_state_callback(self._on_connection_state_change)
        super().destroy()
