"""Public package exports must match what main.py hydrates at deploy time."""
from openvod_transcoder.utils import download_public_url, send_callback, send_heartbeat
from openvod_transcoder.packaging import choose_segment_duration, package_with_shaka


def test_utils_reexports_heartbeat_for_main():
    assert callable(send_heartbeat)
    assert callable(send_callback)
    assert callable(download_public_url)


def test_packaging_reexports_segment_duration_for_main():
    assert callable(choose_segment_duration)
    assert callable(package_with_shaka)
