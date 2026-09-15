"""`python -m openvod_transcoder.agent` — same surface as the console script."""
import sys

from openvod_transcoder.agent.cli import main

if __name__ == "__main__":
    sys.exit(main())
