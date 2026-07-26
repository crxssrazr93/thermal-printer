# create / edit a saved device profile
#
# One form rather than a multi-step wizard: choosing the transport repopulates
# the device list beneath it, which is the only real dependency between fields.

import logging
from typing import Optional

import customtkinter as ctk

from .centered_dialog import CenteredDialog
from ...config.printer_profile import get_profile_labels
from ...core.device_discovery import (
    list_bluetooth_devices,
    list_cups_queues,
    list_usb_devices,
)
from ...core import device_profiles as profiles

logger = logging.getLogger(__name__)


class DeviceProfileDialog(CenteredDialog):

    MIN_WIDTH = 520
    MIN_HEIGHT = 420

    def __init__(self, master, edit_name: Optional[str] = None, **kwargs):
        self._edit_name = edit_name
        self._existing = profiles.find_profile(edit_name) if edit_name else None
        self._device_map = {}
        self._saved_name: Optional[str] = None

        super().__init__(
            master,
            title="Edit device" if edit_name else "Create device profile",
            width=560,
            height=440,
            **kwargs
        )

    # -------------------------------------------------------------------------
    # ui
    # -------------------------------------------------------------------------
    def _build_content(self) -> None:
        label_font = ctk.CTkFont(size=13, weight="bold")
        body_font = ctk.CTkFont(size=13)

        ctk.CTkLabel(
            self.content_frame,
            text="Edit device" if self._edit_name else "Create a device profile",
            font=ctk.CTkFont(size=17, weight="bold")
        ).pack(anchor="w", pady=(0, 4))

        ctk.CTkLabel(
            self.content_frame,
            text="A profile stores how to reach one printer and how it is calibrated.",
            font=body_font, text_color="gray", justify="left"
        ).pack(anchor="w", pady=(0, 14))

        # --- connection type ---
        ctk.CTkLabel(self.content_frame, text="Connection", font=label_font).pack(anchor="w")
        self.transport_var = ctk.StringVar(
            value=(self._existing or {}).get("transport", profiles.TRANSPORT_BLUETOOTH)
        )
        ctk.CTkOptionMenu(
            self.content_frame,
            values=profiles.TRANSPORTS,
            variable=self.transport_var,
            height=34, font=body_font,
            command=lambda _=None: self._reload_devices()
        ).pack(fill="x", pady=(2, 12))

        # --- device ---
        row = ctk.CTkFrame(self.content_frame, fg_color="transparent")
        row.pack(fill="x")
        ctk.CTkLabel(row, text="Device", font=label_font).pack(side="left")
        ctk.CTkButton(
            row, text="Refresh", width=80, height=26, font=body_font,
            command=self._reload_devices
        ).pack(side="right")

        self.device_box = ctk.CTkComboBox(
            self.content_frame, values=[], height=34,
            font=body_font, dropdown_font=body_font,
            command=self._on_device_pick
        )
        self.device_box.pack(fill="x", pady=(2, 12))

        # --- capability profile ---
        ctk.CTkLabel(self.content_frame, text="Printer type", font=label_font).pack(anchor="w")
        self._capability_labels = get_profile_labels()
        current_cap = (self._existing or {}).get("capability_profile", "")
        self.capability_var = ctk.StringVar(
            value=self._capability_labels.get(current_cap, next(iter(self._capability_labels.values())))
        )
        ctk.CTkOptionMenu(
            self.content_frame,
            values=list(self._capability_labels.values()),
            variable=self.capability_var,
            height=34, font=body_font
        ).pack(fill="x", pady=(2, 12))

        # --- name ---
        ctk.CTkLabel(self.content_frame, text="Name", font=label_font).pack(anchor="w")
        self.name_entry = ctk.CTkEntry(self.content_frame, height=34, font=body_font)
        self.name_entry.pack(fill="x", pady=(2, 12))
        if self._existing:
            self.name_entry.insert(0, self._existing.get("name", ""))

        # --- actions ---
        # packed bottom-up before the status line so that a window too short for
        # the form clips the fields, never the buttons that dismiss it
        actions = ctk.CTkFrame(self.content_frame, fg_color="transparent")
        actions.pack(fill="x", side="bottom")

        self.status_label = ctk.CTkLabel(
            self.content_frame, text="", font=body_font, text_color="gray",
            anchor="w"  # the label fills the width, so left-align its text
        )
        self.status_label.pack(pady=(0, 8), side="bottom", fill="x")

        if self._edit_name:
            ctk.CTkButton(
                actions, text="Delete", width=90, height=36,
                fg_color=("red", "#AA0000"), hover_color=("darkred", "#880000"),
                command=self._delete
            ).pack(side="left")

        ctk.CTkButton(
            actions, text="Save", height=36,
            fg_color=("green", "#00AA00"), hover_color=("darkgreen", "#008800"),
            command=self._save
        ).pack(side="right", padx=(6, 0))

        ctk.CTkButton(
            actions, text="Cancel", height=36, command=self._on_close
        ).pack(side="right")

        self._reload_devices()

    # -------------------------------------------------------------------------
    # devices
    # -------------------------------------------------------------------------
    def _reload_devices(self) -> None:
        transport = self.transport_var.get()
        if transport == profiles.TRANSPORT_BLUETOOTH:
            found = list_bluetooth_devices()
        elif transport == profiles.TRANSPORT_USB:
            found = list_usb_devices()
        else:
            found = list_cups_queues()

        self._device_map = dict(found)
        labels = list(self._device_map.keys())
        self.device_box.configure(values=labels)

        # keep the stored address selected when editing
        stored = (self._existing or {}).get("address", "")
        match = next((l for l, v in found if v == stored), None)

        if match:
            self.device_box.set(match)
        elif labels:
            self.device_box.set(labels[0])
        else:
            self.device_box.set(stored)

        self.status_label.configure(
            text=f"{len(labels)} device(s) found" if labels
            else "Nothing found - you can type an address manually"
        )

        if not self.name_entry.get().strip():
            self._autofill_name()

    def _on_device_pick(self, _label: str = "") -> None:
        if not self._edit_name:
            self._autofill_name()

    def _autofill_name(self) -> None:
        label = self.device_box.get().strip()
        if not label:
            return
        # strip the parenthesised address so the default name reads cleanly
        suggestion = label.split(" (")[0].strip() or label
        self.name_entry.delete(0, "end")
        self.name_entry.insert(0, suggestion)

    # -------------------------------------------------------------------------
    # actions
    # -------------------------------------------------------------------------
    def _resolved_address(self) -> str:
        raw = self.device_box.get().strip()
        return self._device_map.get(raw, raw)

    def _capability_key(self) -> str:
        wanted = self.capability_var.get()
        for key, label in self._capability_labels.items():
            if label == wanted:
                return key
        return next(iter(self._capability_labels))

    def _save(self) -> None:
        name = self.name_entry.get().strip()
        address = self._resolved_address()

        if not name:
            self.status_label.configure(text="Give the profile a name")
            return
        if not address:
            self.status_label.configure(text="Pick a device or type an address")
            return

        try:
            self._saved_name = profiles.save_profile(
                name=name,
                transport=self.transport_var.get(),
                address=address,
                capability_profile=self._capability_key(),
                tear_gap_mm=(self._existing or {}).get("tear_gap_mm", 0),
                original_name=self._edit_name,
            )
        except ValueError as error:
            self.status_label.configure(text=str(error))
            return

        self._on_close()

    def _delete(self) -> None:
        if self._edit_name:
            profiles.delete_profile(self._edit_name)
            self._saved_name = None
        self._on_close()

    @property
    def saved_name(self) -> Optional[str]:
        return self._saved_name
