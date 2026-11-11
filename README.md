# UST_room
This project is trying to provide a web for ust student to figure out empty room in campus
Welcome to visit
https://jliip.github.io/ust_room/

## Refresh the course data

Run these commands from the repository root. Replace 2610 with the term code from the HKUST class schedule URL when refreshing for another term.

```sh
python -m pip install -r requirements.txt
python scraper.py --semester 2610
```

The scraper writes the site's `data/schedule.json` after all requested subjects have been parsed. To keep a separate copy, pass `--output data/schedule-2610.json`. Use `--output` with `--subjects` or `--max-subjects` to test a smaller crawl.

The JSON includes the term, source URL, scrape time and subject codes. In schema version 2, each course has a code, name, units and sections. Each section has a class number, enrollment counts and meetings with Hong Kong times, room names and instructors. Meeting dates are inclusive when HKUST provides them. Entries listed as TBA are included in the export.

To preview the site, run `python -m http.server 8000` and open [the local preview](http://localhost:8000/).
