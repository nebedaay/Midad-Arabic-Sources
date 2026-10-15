#!/usr/bin/env python3
"""Central timestamped filename helper. Replaces existing timestamp instead of stacking."""
import re
from pathlib import Path
from datetime import datetime

TIMESTAMP_RE = re.compile(r'\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}')

def stamped(path: Path, suffix: str = "") -> Path:
    """Return path with current timestamp, replacing any existing one.
    
    file.formatted.2026-08-03_12-00-00.md → file.formatted.2026-08-03_13-00-00.md
    file.md → file.2026-08-03_13-00-00.md (if no suffix, just timestamp)
    """
    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    stem = TIMESTAMP_RE.sub("", path.stem)
    # Remove trailing dots from consecutive timestamp removal
    stem = stem.rstrip(".")
    if suffix:
        stem = f"{stem}.{suffix}"
    return path.parent / f"{stem}.{ts}{path.suffix}"
