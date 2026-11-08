import unittest

from fastapi import HTTPException

from app import build_format_options, validate_public_url, _format_plan


class UrlValidationTests(unittest.TestCase):
    def test_rejects_file_scheme(self):
        with self.assertRaises(HTTPException):
            validate_public_url("file:///etc/passwd")

    def test_rejects_localhost(self):
        with self.assertRaises(HTTPException):
            validate_public_url("http://localhost/video.mp4")

    def test_rejects_private_ip(self):
        with self.assertRaises(HTTPException):
            validate_public_url("http://127.0.0.1/video.mp4")


class FormatSelectionTests(unittest.TestCase):
    def setUp(self):
        self.info = {
            "title": "Sample video",
            "formats": [
                {"format_id": "v1080", "vcodec": "avc1", "acodec": "none", "height": 1080},
                {"format_id": "v720", "vcodec": "avc1", "acodec": "none", "height": 720},
                {"format_id": "a128", "vcodec": "none", "acodec": "mp4a", "abr": 128},
            ],
        }

    def test_returns_quality_and_mp3_options(self):
        options = build_format_options(self.info)
        ids = [item["id"] for item in options]
        self.assertEqual(ids, ["best", "p720", "mp3"])

    def test_best_selection_uses_separate_audio_and_video(self):
        plan = _format_plan("best", self.info)
        self.assertEqual(plan["format"], "bestvideo+bestaudio/best")

    def test_rejects_unlisted_format(self):
        with self.assertRaises(HTTPException):
            _format_plan("p4320", self.info)


if __name__ == "__main__":
    unittest.main()
