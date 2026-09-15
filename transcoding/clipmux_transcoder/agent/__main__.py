"""`python -m clipmux_transcoder.agent` — same surface as the console script."""
import sys

from clipmux_transcoder.agent.cli import main

if __name__ == "__main__":
    sys.exit(main())
