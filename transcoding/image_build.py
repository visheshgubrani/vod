"""Image build helpers, importable before the pipeline modules are attached."""


def download_whisper_weights() -> None:
    """Bake Whisper weights into the image (Modal run_function, 1h timeout)."""
    from faster_whisper.utils import download_model

    # Resolve the same alias as WhisperModel at runtime, including its cache key.
    # The default model is public and requires no Hugging Face credentials.
    download_model("large-v3-turbo", use_auth_token=False)
