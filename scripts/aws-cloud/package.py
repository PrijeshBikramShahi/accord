"""Build the allowlisted upload package without credentials, state or AWS calls."""
import json
from pathlib import Path
import zipfile

from template import build

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DESTINATION = ROOT / "dist/accord-cloud-foundation.zip"


def package():
    template = json.dumps(build(), indent=2)
    if len(json.dumps(build()).encode()) > 51200:
        raise RuntimeError("Template exceeds CloudFormation inline limit")
    DESTINATION.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(DESTINATION, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in ("README.md", "cloud.py", "template.py", "test_cloud.py"):
            archive.write(HERE / name, "accord-cloud-foundation/" + name)
        for name in ("handler.py", "test_handler.py", "test_briefs.py"):
            archive.write(ROOT / "apps/cloud-api" / name, "accord-cloud-foundation/" + name)
        archive.writestr("accord-cloud-foundation/template.json", template + "\n")
    print(DESTINATION)


if __name__ == "__main__":
    package()
