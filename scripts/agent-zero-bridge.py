"""Guest-only adapter for Agent Zero's Tool/Response contract.

Contract reference: agent0ai/agent-zero ff2a5b9c, helpers/tool.py (MIT).
This implements the tool boundary; Agent Zero's UI and lifecycle engine are not loaded.
"""
import asyncio
import contextlib
from dataclasses import dataclass
import importlib.util
import inspect
import json
import os
from pathlib import Path
import re
import sys
import types
import uuid


@dataclass
class Response:
    message: str
    break_loop: bool
    additional: dict | None = None


class LogEntry:
    def __init__(self, **kwargs):
        self.id = str(uuid.uuid4())
        self.update(**kwargs)

    def update(self, **kwargs):
        self.__dict__.update(kwargs)
        print(json.dumps({"plugin_log": kwargs}, ensure_ascii=False), file=sys.stderr)


class Logger:
    def log(self, **kwargs):
        return LogEntry(**kwargs)


class Agent:
    def __init__(self, request, root):
        self.agent_name = request["agent_name"]
        self.context = types.SimpleNamespace(id=request["context_id"], log=Logger())
        self.state_path = root / ".pa-state" / (request["context_id"] + ".json")
        self.data = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}

    def get_data(self, key, default=None):
        return self.data.get(key, default)

    def set_data(self, key, value):
        self.data[key] = value
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(".partial")
        temporary.write_text(json.dumps(self.data), encoding="utf-8")
        temporary.replace(self.state_path)

    def hist_add_tool_result(self, name, text, **kwargs):
        # The host records the returned result in its existing durable task history.
        print(json.dumps({"tool": name, "message": text}, ensure_ascii=False), file=sys.stderr)


class Tool:
    def __init__(self, agent, name, method, args, message, loop_data, **kwargs):
        self.agent, self.name, self.method = agent, name, method
        self.args, self.message, self.loop_data = args, message, loop_data
        self.progress = ""

    def get_log_object(self):
        return self.agent.context.log.log(type="tool", heading=self.name, kvps=self.args)

    async def before_execution(self, **kwargs):
        self.log = self.get_log_object()

    async def after_execution(self, response, **kwargs):
        self.agent.hist_add_tool_result(self.name, response.message, **(response.additional or {}))

    async def set_progress(self, content):
        self.progress = content or ""
        self.log.update(content=self.progress)

    def add_progress(self, content):
        self.progress += content or ""


def module(name, **values):
    result = types.ModuleType(name)
    result.__dict__.update(values)
    sys.modules[name] = result
    return result


async def main():
    request = json.load(sys.stdin)
    root = Path(__file__).resolve().parent
    plugin = request["plugin"]
    tool_name = request["tool"]
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", plugin) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,100}", tool_name):
        raise ValueError("Invalid plugin or tool name")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", request["context_id"]):
        raise ValueError("Invalid task context")
    module("agent", Agent=Agent, LoopData=types.SimpleNamespace)
    module("helpers", __path__=[])
    module("helpers.tool", Tool=Tool, Response=Response)
    module("helpers.strings", sanitize_string=lambda value: str(value))

    def get_plugin_config(plugin_name, agent=None, **kwargs):
        if plugin_name != plugin:
            raise ValueError("Cross-plugin configuration is unavailable in this task")
        return json.loads(json.dumps(request["config"]))

    module("helpers.plugins", get_plugin_config=get_plugin_config)
    module("usr", __path__=[])
    module("usr.plugins", __path__=[])
    module("usr.plugins." + plugin, __path__=[str(root)])
    # Plugin-local helpers retain their original usr.plugins.<name> imports.
    full_name = "usr.plugins." + plugin + ".tools." + tool_name
    spec = importlib.util.spec_from_file_location(full_name, root / "tools" / (tool_name + ".py"))
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[full_name] = loaded
    with contextlib.redirect_stdout(sys.stderr):
        spec.loader.exec_module(loaded)
        classes = [value for value in vars(loaded).values()
                   if inspect.isclass(value) and value.__module__ == full_name and issubclass(value, Tool)]
        if len(classes) != 1:
            raise ValueError("A tool module must define exactly one Tool subclass")
        tool = classes[0](agent=Agent(request, root), name=tool_name,
                          method=request.get("method"), args=request["args"],
                          message="", loop_data=None)
        await tool.before_execution(**request["args"])
        response = await tool.execute(**request["args"])
        if not isinstance(response, Response) or not isinstance(response.message, str):
            raise TypeError("Plugin tool must return helpers.tool.Response with a text message")
        await tool.after_execution(response, **request["args"])
    receipt = json.dumps({
        "message": response.message, "breakLoopRequested": response.break_loop,
        "additional": response.additional,
    }, ensure_ascii=False)
    results = root / ".pa-results"
    results.mkdir(exist_ok=True)
    result = results / (os.environ["PA_ACTION_ID"] + ".json")
    temporary = result.with_suffix(".partial")
    temporary.write_text(receipt, encoding="utf-8")
    temporary.replace(result)
    print("Plugin result saved: " + str(result))


if __name__ == "__main__":
    asyncio.run(main())
