import sys
import unittest
from pathlib import Path
from lxml import etree
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from tm_splitter_adapted import extract_trademark
class FixtureShapeTests(unittest.TestCase):
    def test_shipped_fixture_matches_official_case_file_identity_layout(self):
        root = etree.parse(str(Path(__file__).resolve().parents[1] / 'fixtures' / 'sample-trademark.xml'))
        cases = root.findall('.//case-file')
        self.assertEqual(len(cases), 4)
        records = []
        for case in cases:
            self.assertIsNotNone(case.find('serial-number'))
            self.assertIsNone(case.find('case-file-header/serial-number'))
            records.extend(extract_trademark(case) or [])
        self.assertEqual(len(records), 4)
        self.assertTrue(records[0]['registration_number'])
        self.assertTrue(all(record['jurisdiction'] == 'US' for record in records))
    def test_production_parser_does_not_accept_wrong_nested_serial_example(self):
        case = etree.fromstring(b'<case-file><case-file-header><serial-number>synthetic</serial-number><mark-identification>FIXTURE</mark-identification><mark-drawing-code>4</mark-drawing-code></case-file-header></case-file>')
        self.assertIsNone(extract_trademark(case))
if __name__ == '__main__': unittest.main()
