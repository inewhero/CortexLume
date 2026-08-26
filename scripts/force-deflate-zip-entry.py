from __future__ import annotations

import copy
import os
import shutil
import sys
import zipfile
from pathlib import Path


def force_deflate_entry(archive_path: Path, target_name: str) -> None:
    target_name = target_name.replace("\\", "/")
    temporary_path = archive_path.with_suffix(f"{archive_path.suffix}.rewrite.tmp")
    found = False

    try:
        with zipfile.ZipFile(archive_path, "r") as source, zipfile.ZipFile(
            temporary_path,
            "w",
            allowZip64=True,
        ) as destination:
            for source_info in source.infolist():
                destination_info = copy.copy(source_info)
                if source_info.filename == target_name:
                    destination_info.compress_type = zipfile.ZIP_DEFLATED
                    destination_info._compresslevel = 1
                    found = True

                if source_info.is_dir():
                    destination.writestr(destination_info, b"")
                    continue

                with source.open(source_info, "r") as input_file, destination.open(
                    destination_info,
                    "w",
                    force_zip64=True,
                ) as output_file:
                    shutil.copyfileobj(input_file, output_file, length=1024 * 1024)

        if not found:
            raise RuntimeError(f"ZIP entry was not found: {target_name}")

        with zipfile.ZipFile(temporary_path, "r") as rewritten:
            rewritten_info = rewritten.getinfo(target_name)
            if rewritten_info.compress_type != zipfile.ZIP_DEFLATED:
                raise RuntimeError(f"ZIP entry was not Deflate-compressed: {target_name}")

        os.replace(temporary_path, archive_path)
    finally:
        temporary_path.unlink(missing_ok=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: force-deflate-zip-entry.py <archive> <entry>")
    force_deflate_entry(Path(sys.argv[1]).resolve(), sys.argv[2])
