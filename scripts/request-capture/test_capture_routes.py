import unittest
from unittest.mock import patch
from types import SimpleNamespace

from capture_addon import target


class CaptureRouteTests(unittest.TestCase):
    def test_explicit_reverse_proxy_hosts_only_allow_model_routes(self):
        with patch.dict('os.environ', {'CAPTURE_ALLOWED_HOSTS': ' sub2api.monasapi.com,172.20.0.1 '}):
            for host in ('sub2api.monasapi.com', '172.20.0.1'):
                self.assertTrue(target(SimpleNamespace(host=host, url='http://'+host+'/v1/responses')))
                self.assertFalse(target(SimpleNamespace(host=host, url='http://'+host+'/auth/refresh')))
            self.assertFalse(target(SimpleNamespace(host='unrelated.example', url='http://unrelated.example/v1/responses')))

    def test_image_generation_is_captured_at_both_observation_points(self):
        for host, route in [('127.0.0.1', '/v1/images/generations'),
                            ('localhost', '/v1/images/generations'),
                            ('::1', '/v1/images/generations'),
                            ('chatgpt.com', '/backend-api/codex/images/generations')]:
            with self.subTest(host=host):
                self.assertTrue(target(SimpleNamespace(host=host, url='http://example'+route)))

    def test_unrelated_authentication_and_external_paths_remain_outside_scope(self):
        for host, route in [('127.0.0.1', '/auth/refresh'),
                            ('chatgpt.com', '/api/auth/session'),
                            ('auth.openai.com', '/oauth/token'),
                            ('example.test', '/v1/images/generations')]:
            with self.subTest(host=host, route=route):
                self.assertFalse(target(SimpleNamespace(host=host, url='https://example'+route)))


if __name__ == '__main__':
    unittest.main()
