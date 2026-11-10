"""Range imports must validate the spreadsheet before accessing the database."""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import openpyxl

spec = importlib.util.spec_from_file_location(
    'clic_import', Path(__file__).resolve().parents[1] / 'scripts/upsert_clic_selection.py')
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)


class SelectionTests(unittest.TestCase):
    def test_content_before_heading_is_preserved(self):
        """Page 886 places its actual paragraph before the page heading."""
        source = '<p>Legal Aid Schemes and the Duty Lawyer Scheme.</p><h2>III. Case Illustration</h2>'
        self.assertEqual(cli.parse_content(source), 'Legal Aid Schemes and the Duty Lawyer Scheme.')
        self.assertEqual(cli.parse_content('<h2>Title</h2><p>Body</p>'), 'Body')
        self.assertEqual(cli.parse_content('<p>No heading</p>'), 'No heading')

    def test_incomplete_range_stops_before_database(self):
        with patch.object(sys, 'argv', ['import', '--add-lo', '2759', '--add-hi', '2973']), \
             patch.object(cli, 'read_selection', return_value=([{'second_id': 2759, 'nid': 3544, 'content_html': '<p>Content</p>', 'struck': False, 'url': 'https://clic.org.hk/en/topics/test', 'title': 'Page'}], {})), \
             patch.object(cli, 'load_dotenv') as config:
            with self.assertRaisesRegex(SystemExit, 'missing 214 ID'):
                cli.main()
            config.assert_not_called()

    def test_filtered_row_cannot_satisfy_requested_range(self):
        """Every requested ID must survive filtering before database access."""
        valid = {'second_id': 2759, 'nid': 3544, 'content_html': '<p>Content</p>',
                 'struck': False, 'url': 'https://clic.org.hk/en/topics/test', 'title': 'Page'}
        for change in [{'content_html': ''}, {'struck': True}, {'result_flag': 'Delete'},
                       {'url': ''}, {'url': 'https://clic.org.hk/en/invalid'}, {'title': ''}]:
            with self.subTest(change=change), \
                 patch.object(sys, 'argv', ['import', '--add-lo', '2759', '--add-hi', '2759', '--apply']), \
                 patch.object(cli, 'read_selection', return_value=([{**valid, **change}], {})), \
                 patch.object(cli, 'load_dotenv', return_value={}) as config:
                with self.assertRaisesRegex(SystemExit, 'missing 1 ID'):
                    cli.main()
                config.assert_not_called()

    def test_reversed_range_stops_before_reading_spreadsheet(self):
        with patch.object(sys, 'argv', ['import', '--add-lo', '2973', '--add-hi', '2759']), \
             patch.object(cli, 'read_selection') as read:
            with self.assertRaises(SystemExit):
                cli.main()
            read.assert_not_called()

    def test_selection_uses_column_c_not_nid_or_excel_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'content.xlsx'
            wb = openpyxl.Workbook()
            ws = wb.active
            ws.title = 'EN'
            ws.append(['langcode', '1st_id', '2nd_id', 'nid', 'Included?',
                       'Result', 'title', 'full_path', 'topic', 'content'])
            for second, nid in [(2758, 2759), (2759, 3544), (2973, 4000), (2974, 2973)]:
                ws.append(['en', None, second, nid, None, None, 'Page',
                           'https://clic.org.hk/en/topics/test', 'test', '<p>Content</p>'])
            wb.save(path)
            rows, _ = cli.read_selection(path, 2759, 2973, [])
            self.assertEqual([(r['second_id'], r['nid']) for r in rows],
                             [(2759, 3544), (2973, 4000)])


if __name__ == '__main__':
    unittest.main()
