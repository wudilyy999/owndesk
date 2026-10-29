"""GTK fixture using installed desktop libraries, with no extra test packages."""
from ctypes import CDLL, CFUNCTYPE, c_void_p as P, c_int as I, c_uint as U, c_char_p as S, c_double as D

gtk = CDLL("libgtk-3.so.0")
atk = CDLL("libatk-1.0.so.0")
gobject = CDLL("libgobject-2.0.so.0")
glib = CDLL("libglib-2.0.so.0")


def bind(library, name, result, args):
    function = getattr(library, name)
    function.restype, function.argtypes = result, args
    return function


init = bind(gtk, "gtk_init", None, [P, P])
window_new = bind(gtk, "gtk_window_new", P, [I])
title = bind(gtk, "gtk_window_set_title", None, [P, S])
size = bind(gtk, "gtk_window_set_default_size", None, [P, I, I])
box_new = bind(gtk, "gtk_box_new", P, [I, I])
border = bind(gtk, "gtk_container_set_border_width", None, [P, U])
add = bind(gtk, "gtk_container_add", None, [P, P])
pack = bind(gtk, "gtk_box_pack_start", None, [P, P, I, I, U])
label = bind(gtk, "gtk_label_new", P, [S])
label_text = bind(gtk, "gtk_label_set_text", None, [P, S])
button = bind(gtk, "gtk_button_new_with_label", P, [S])
sensitive = bind(gtk, "gtk_widget_set_sensitive", None, [P, I])
entry_new = bind(gtk, "gtk_entry_new", P, [])
entry_text = bind(gtk, "gtk_entry_set_text", None, [P, S])
entry_visibility = bind(gtk, "gtk_entry_set_visibility", None, [P, I])
accessible = bind(gtk, "gtk_widget_get_accessible", P, [P])
accessible_name = bind(atk, "atk_object_set_name", None, [P, S])
check_new = bind(gtk, "gtk_check_button_new_with_label", P, [S])
checked = bind(gtk, "gtk_toggle_button_set_active", None, [P, I])
scale_new = bind(gtk, "gtk_scale_new_with_range", P, [I, D, D, D])
scale_value = bind(gtk, "gtk_range_set_value", None, [P, D])
show = bind(gtk, "gtk_widget_show_all", None, [P])
hide = bind(gtk, "gtk_widget_hide", None, [P])
present = bind(gtk, "gtk_window_present", None, [P])
connect = bind(gobject, "g_signal_connect_data", P, [P, S, P, P, P, I])
timeout = bind(glib, "g_timeout_add", U, [U, P, P])
main = bind(gtk, "gtk_main", None, [])
init(None, None)
window = window_new(0)
title(window, b"AT-SPI Observation Fixture")
size(window, 620, 650)
box = box_new(1, 12)
border(box, 20)
add(window, box)
status = label(b"Ready for observation")
save = button(b"Save report")


@CFUNCTYPE(None, P, P)
def on_save(*_):
    label_text(status, b"Report saved")


connect(save, b"clicked", on_save, None, None, 0)
disabled = button(b"Disabled export")
sensitive(disabled, 0)
entry = entry_new()
accessible_name(accessible(entry), b"Report title")
entry_text(entry, b"Quarterly report")
secret = entry_new()
entry_visibility(secret, 0)
entry_text(secret, b"FIXTURE_PASSWORD_MUST_NOT_LEAK")
check = check_new(b"Enable sync")
checked(check, 1)
slider = scale_new(0, 0, 100, 1)
scale_value(slider, 37)
accessible_name(accessible(slider), b"Volume")
hidden = label(b"HIDDEN_CONTROL_MUST_NOT_LEAK")
for widget in (status, save, disabled, entry, secret, check, slider, hidden):
    pack(box, widget, 0, 0, 0)
show(window)
hide(hidden)
other = window_new(0)
title(other, b"Background fixture")
add(other, label(b"BACKGROUND_WINDOW_MUST_NOT_LEAK"))
show(other)


@CFUNCTYPE(I, P)
def focus(_):
    present(window)
    return 0


timeout(500, focus, None)
main()
