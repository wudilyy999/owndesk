"""Exercise the shipped window resolver with bounded synthetic AT-SPI objects."""
import sys
from types import SimpleNamespace

sys.path.insert(0, "/opt/owndesk-controller")
import accessibility as bridge

ax = bridge.ax
calls = {"metadata": 0}


def node(role, children=(), pid=1):
    return SimpleNamespace(role=role, children=list(children), pid=pid)


desktop = node("desktop", [node("application", [node("frame", pid=i+100)]) for i in range(105)])
bridge.Atspi = SimpleNamespace(get_desktop=lambda _: desktop)
ax._atspi_child_count = lambda element: len(element.children)
ax._atspi_child_at = lambda element, index: element.children[index] if index < len(element.children) else None
ax._atspi_role = lambda element: element.role
ax._atspi_name = lambda element: "Synthetic application"


def metadata(_atspi, element, *, path, session):
    calls["metadata"] += 1
    return {"role":element.role,"path":path,"pid":element.pid,"states":["enabled","visible","showing"],
            "objectId":{"bus":":test","path":"/node/"+"/".join(map(str,path))}}


ax._atspi_node_metadata = metadata
session = SimpleNamespace(width=1280, height=800)
records, truncated = bridge.windows(desktop, session, {"max_windows":500})
assert len(records) == 105 and not truncated
assert records[-1][1]["app_name"] == "Synthetic application" and records[-1][1]["visible"]
capped, truncated = bridge.windows(desktop, session, {"max_windows":3})
assert len(capped) == 3 and truncated
window_id = records[104][1]["window_id"]
calls["metadata"] = 0
element, actual = bridge.select_window([], {"width":1280,"height":800}, {"window_id":window_id})
assert element.pid == 204 and actual["window_id"] == window_id and calls["metadata"] == 1
try:
    bridge.select_window([], {"width":1280,"height":800}, {"window_id":window_id,"pid":9999})
except ax.PortalError as error:
    assert error.code == "WINDOW_NOT_EXPOSED"
else:
    raise AssertionError("Mismatching process identity must be rejected")

crowded = node("desktop", [node("application", [node("panel") for _ in range(805)])])
records, truncated = bridge.windows(crowded, session, {"max_windows":500})
assert records == [] and truncated


def unavailable(_element):
    raise ax.PortalError("AT_SPI_READ_LIMIT", "Injected enumeration time limit")


ax._atspi_child_count = unavailable
failed = bridge.snapshot({"state":{"width":1280,"height":800},"options":{"action":"list_windows"}})
assert failed["effect"] == "none" and failed["code"] == "AT_SPI_READ_LIMIT" and failed["windows"] == []
print("105 applications, enumeration limits, direct window path/PID and explicit read failures passed")
