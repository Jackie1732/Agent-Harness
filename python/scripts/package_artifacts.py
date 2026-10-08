"""Inspect and bundle the locally built Python distribution using the standard library."""

import importlib.metadata
import json
import platform
import sys
import sysconfig
import tarfile
import tomllib
import zipfile
from pathlib import Path

VERSION = tomllib.loads(
    (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text("utf-8")
)["project"]["version"]


def inspect(wheel: Path, sdist: Path) -> None:
    required = {"atomic_harness/control-schema.json", "atomic_harness/types.py",
                "atomic_harness/client.pyi", "atomic_harness/py.typed"}
    with zipfile.ZipFile(wheel) as archive:
        assert required <= set(archive.namelist())
        assert all(name.startswith(("atomic_harness/", f"atomic_agent_harness-{VERSION}.dist-info/"))
                   for name in archive.namelist())
        assert not any(name.endswith((".pem", ".log", ".md")) or "__pycache__" in name
                       for name in archive.namelist())
    with tarfile.open(sdist) as archive:
        assert all(any(name.endswith("src/" + field) for name in archive.getnames()) for field in required)
        assert all(name.startswith(f"atomic_agent_harness-{VERSION}/src/atomic_harness/")
                   or name in (f"atomic_agent_harness-{VERSION}/pyproject.toml",
                               f"atomic_agent_harness-{VERSION}/PKG-INFO",
                               f"atomic_agent_harness-{VERSION}/.gitignore")
                   for name in archive.getnames())
    print("wheel and sdist contain complete generated protocol and typing")


def bundle(output: Path, cache: Path, wheel: Path, sdist: Path, manifest: Path) -> None:
    instruction = (
        "Create a Python >=3.11 virtual environment. Install with:\n"
        f"python -m pip install --no-index --find-links wheelhouse atomic-agent-harness=={VERSION}\n"
        "The dependency cache supports the actual interpreter/platform wheel tags recorded in "
        "python-release-manifest.json. The SDK wheel is pure Python. No registry upload was performed.\n"
    )
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(cache.glob("*.whl")):
            archive.write(path, "wheelhouse/" + path.name)
        for path in (wheel, sdist, manifest):
            archive.write(path, path.name)
        archive.writestr("INSTALL.txt", instruction)


operation = sys.argv[1]
if operation == "metadata":
    print(json.dumps({"version": VERSION, "python": sys.version, "platform": sysconfig.get_platform(),
                      "machine": platform.machine(),
                      "packages": {name: importlib.metadata.version(name)
                                   for name in ("jsonschema", "build", "hatchling")}}))
elif operation == "inspect":
    inspect(*map(Path, sys.argv[2:]))
elif operation == "extract":
    source, destination = map(Path, sys.argv[2:])
    destination.mkdir()
    with tarfile.open(source) as archive:
        archive.extractall(destination, filter="data")
elif operation == "bundle":
    bundle(*map(Path, sys.argv[2:]))
else:
    raise ValueError("Unknown package artifact operation")
