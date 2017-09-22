import os
import unittest


class MockSkylark:
  """A class that returns mocked bazel version and fail().

  Used to stub out skylark runtime.
  """

  failure = None

  def setVersion(self, version):
    self.bazel_version = version

  def fail(self, message):
    self.failure = message


class CheckBazelVersionTest(unittest.TestCase):
  BZL_PATH = 'build_bazel_rules_nodejs/internal/check_bazel_version.bzl'

  def setUp(self):
    self.mock = MockSkylark()
    self.globals = {
        'native': self.mock,
        'fail': self.mock.fail.__get__(self.mock, MockSkylark),
    }
    execfile(os.path.join(os.environ['TEST_SRCDIR'], self.BZL_PATH), self.globals)

  def testVeryOldBazel(self):
    # Don't call setVersion, so there is no bazel_version property
    self.globals['check_bazel_version']('1.2.3')
    self.assertIn('Current Bazel version is lower than 0.2.1', self.mock.failure)

  def testVersionComparison(self):
    self.mock.setVersion('1.2.2')
    self.globals['check_bazel_version']('1.2.3')
    self.assertIn('expected at least 1.2.3', self.mock.failure)

  def testNotAlphaComparison(self):
    self.mock.setVersion('1.12.3')
    self.globals['check_bazel_version']('1.2.1')
    self.assertIsNone(self.mock.failure)

if __name__ == '__main__':
  unittest.main()
