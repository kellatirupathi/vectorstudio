from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

_ENV_LOADED = False


def load_environment() -> None:
    """Load environment variables from .env in project root once per process."""
    global _ENV_LOADED
    if _ENV_LOADED:
        return

    project_root = Path(__file__).resolve().parent.parent
    env_file = os.getenv("APP_ENV_FILE")
    dotenv_path = Path(env_file) if env_file else project_root / ".env"
    load_dotenv(dotenv_path=dotenv_path, override=False)
    _ENV_LOADED = True
