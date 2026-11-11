"""Export HKUST Class Schedule & Quota as a reusable course dataset."""

import argparse
import json
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

BASE_URL_TEMPLATE = "https://w5.ab.ust.hk/wcq/cgi-bin/{semester}/"
DEFAULT_SEMESTER = "2610"
DEFAULT_OUTPUT = Path(__file__).parent / "data" / "schedule.json"
HEADERS = {"User-Agent": "USTEmptyRoom/1.0 (https://github.com/jliip/ust_room)"}

COURSE_TITLE = re.compile(r"([A-Z]+\s+\d+\w*)\s+-\s+(.+)")
COURSE_UNITS = re.compile(r"\s+\((\d+(?:\.\d+)?) units?\)$")
SECTION_TITLE = re.compile(r"(.+?)\s*\((\d+)\)")
DATE = r"\d{1,2}-[A-Z]{3}-\d{4}"
DATE_RANGE = re.compile(rf"({DATE})(?:\s*-\s*({DATE}))?", re.IGNORECASE)
TIME = r"\d{1,2}:\d{2}(?:[AP]M)?"
TIME_SLOT = re.compile(rf"((?:Mo|Tu|We|Th|Fr|Sa|Su)+)\s+({TIME})\s*-\s*({TIME})")
COUNT_COLUMNS = ("Quota", "Enrol", "Avail", "Wait")
UNSPECIFIED = {"", "TBA", "TBC", "N/A", "-", "—"}


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--semester",
        default=DEFAULT_SEMESTER,
        help=f"Four-digit HKUST term code (default: {DEFAULT_SEMESTER})",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Output JSON path")
    parser.add_argument("--subjects", nargs="+", help="Subject codes to scrape (e.g. ACCT COMP)")
    parser.add_argument("--subjects-file", type=Path, help="File with one subject code per line")
    parser.add_argument("--delay", type=float, default=0.3, help="Seconds between requests")
    parser.add_argument("--max-subjects", type=int, help="Limit the crawl for testing")
    args = parser.parse_args()

    args.semester = args.semester.strip().strip("/")
    if not re.fullmatch(r"[0-9]{4}", args.semester):
        parser.error("--semester must be a four-digit HKUST term code")
    if args.delay < 0:
        parser.error("--delay must be non-negative")
    if args.max_subjects is not None and args.max_subjects < 1:
        parser.error("--max-subjects must be positive")
    return args


def get_soup(session: requests.Session, url: str) -> BeautifulSoup:
    for attempt in range(3):
        try:
            response = session.get(url, timeout=30)
            response.raise_for_status()
            if response.url.rstrip("/") != url.rstrip("/"):
                raise ValueError(f"Unexpected redirect to {response.url}")
            return BeautifulSoup(response.content, "html.parser")
        except requests.RequestException as error:
            if attempt == 2:
                raise
            print(f"Retrying {url}: {error}", flush=True)
            time.sleep(2 * (attempt + 1))


def get_subject_links(soup: BeautifulSoup, base_url: str) -> list[str]:
    prefix = base_url + "subject/"
    links = []
    for element in soup.select("a[href], [data-href], [data-url], option[value]"):
        href = next(
            (element[attr] for attr in ("href", "data-href", "data-url", "value") if element.get(attr)),
            "",
        )
        url = urljoin(base_url, href.strip()).split("#", 1)[0]
        if url.startswith(prefix) and re.fullmatch(r"[A-Z0-9]+/?", url[len(prefix):]):
            links.append(url.rstrip("/"))
    return list(dict.fromkeys(links))


def get_semester_name(soup: BeautifulSoup, base_url: str) -> str | None:
    term_path = urlsplit(base_url).path
    label = soup.select_one(f'.term a[href="{term_path}"]')
    return label.get_text(" ", strip=True) if label else None


def parse_time(value: str) -> str:
    time_format = "%I:%M%p" if value.endswith(("AM", "PM")) else "%H:%M"
    return datetime.strptime(value, time_format).strftime("%H:%M")


def parse_meetings(cells: dict) -> list[dict]:
    date_and_time = cells["Date & Time"].get_text("\n", strip=True).splitlines()
    start_date = end_date = None
    if date_and_time and (dates := DATE_RANGE.fullmatch(date_and_time[0])):
        first_date, last_date = dates.groups()
        start_date = datetime.strptime(first_date, "%d-%b-%Y").date().isoformat()
        end_date = datetime.strptime(last_date or first_date, "%d-%b-%Y").date().isoformat()
        date_and_time = date_and_time[1:]

    room = " ".join(cells["Room"].get_text(" ", strip=True).split()) or None
    instructors = list(cells["Instructor"].stripped_strings)
    meetings = []
    for line in date_and_time or [""]:
        slot = " ".join(line.split())
        days = []
        start_time = end_time = None
        if slot.upper() not in UNSPECIFIED:
            match = TIME_SLOT.fullmatch(slot)
            if not match:
                raise ValueError(f"Unrecognized meeting time: {slot!r}")
            weekdays, start, end = match.groups()
            days = re.findall(r"[A-Z][a-z]", weekdays)
            start_time, end_time = parse_time(start), parse_time(end)
        meetings.append({
            "days": days,
            "start_time": start_time,
            "end_time": end_time,
            "start_date": start_date,
            "end_date": end_date,
            "room": room,
            "instructors": instructors,
        })
    return meetings


def parse_count(cell) -> int | None:
    # The first text in the quota cell is the total, before any quota breakdown.
    value = next(cell.stripped_strings, "").replace(",", "")
    return None if value.upper() in UNSPECIFIED else int(value)


def parse_sections(table) -> list[dict]:
    columns = [cell.get_text(" ", strip=True) for cell in table.select_one("tr").find_all("th")]
    required = {"Section", "Date & Time", "Room", "Instructor", *COUNT_COLUMNS}
    if not required.issubset(columns):
        raise ValueError(f"Unrecognized section columns: {columns}")

    sections = []
    for row in table.select("tr.mainRow, tr.otherRow"):
        cells = row.find_all("td", recursive=False)
        if len(cells) != len(columns):
            raise ValueError(f"Expected {len(columns)} section cells, found {len(cells)}")
        cells = dict(zip(columns, cells))
        if "mainRow" in row.get("class", []):
            label = cells["Section"].get_text(" ", strip=True)
            section = SECTION_TITLE.fullmatch(label)
            if not section:
                raise ValueError(f"Unrecognized section: {label!r}")
            counts = {column.lower(): parse_count(cells[column]) for column in COUNT_COLUMNS}
            sections.append({
                "section": section[1],
                "class_number": int(section[2]),
                **counts,
                "meetings": [],
            })
        if not sections:
            raise ValueError("Meeting row has no section")
        sections[-1]["meetings"].extend(parse_meetings(cells))
    return sections


def parse_subject(soup: BeautifulSoup) -> list[dict]:
    courses = []
    for block in soup.select("div.course"):
        heading = block.select_one(".subject") or block.select_one("h2")
        title = heading.get_text(" ", strip=True) if heading else ""
        course = COURSE_TITLE.fullmatch(title)
        if not course:
            raise ValueError(f"Unrecognized course title: {title!r}")
        code, name = course.groups()
        units = None
        if match := COURSE_UNITS.search(name):
            name = name[:match.start()]
            value = match[1]
            units = float(value) if "." in value else int(value)

        sections = []
        try:
            for table in block.select("table.sections"):
                sections.extend(parse_sections(table))
            if not sections:
                raise ValueError("No section rows found")
        except ValueError as error:
            raise ValueError(f"{code}: {error}") from error
        courses.append({"code": " ".join(code.split()), "name": name, "units": units, "sections": sections})

    if not courses:
        raise ValueError("No courses found on subject page")
    return courses


def save_schedule(data: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = NamedTemporaryFile(
        mode="w", encoding="utf-8", newline="\n", dir=path.parent, suffix=".tmp", delete=False
    )
    temporary_path = Path(temporary.name)
    try:
        with temporary:
            json.dump(data, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)


def main() -> None:
    args = parse_arguments()
    base_url = BASE_URL_TEMPLATE.format(semester=args.semester)
    subject_codes = list(args.subjects or [])
    if args.subjects_file:
        subject_codes.extend(args.subjects_file.read_text(encoding="utf-8-sig").splitlines())
    subject_codes = list(dict.fromkeys(code.strip().upper() for code in subject_codes if code.strip()))
    if any(not re.fullmatch(r"[A-Z0-9]+", code) for code in subject_codes):
        raise SystemExit("Subject codes must contain only letters and digits")

    courses = []
    semester_name = None
    print(f"Scraping HKUST term {args.semester}", flush=True)
    with requests.Session() as session:
        session.headers.update(HEADERS)
        if subject_codes:
            links = [f"{base_url}subject/{code}" for code in subject_codes]
        else:
            index = get_soup(session, base_url)
            links = get_subject_links(index, base_url)
            semester_name = get_semester_name(index, base_url)
        if not links:
            raise SystemExit(f"No subjects listed at {base_url}")

        links = links[:args.max_subjects]
        for index, url in enumerate(links, 1):
            subject = url.rsplit("/", 1)[-1]
            try:
                soup = get_soup(session, url)
                subject_courses = parse_subject(soup)
            except (requests.RequestException, ValueError) as error:
                raise SystemExit(f"Could not scrape {subject} from {url}: {error}") from error
            semester_name = semester_name or get_semester_name(soup, base_url)
            courses.extend(subject_courses)
            print(f"[{index}/{len(links)}] {subject}: {len(subject_courses)} courses", flush=True)
            if index < len(links):
                time.sleep(args.delay)

    data = {
        "schema_version": 2,
        "semester": args.semester,
        "semester_name": semester_name or f"Term {args.semester}",
        "timezone": "Asia/Hong_Kong",
        "scraped_at": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
        "source_url": base_url,
        "subjects": [url.rsplit("/", 1)[-1] for url in links],
        "courses": courses,
    }
    save_schedule(data, args.output)
    section_count = sum(len(course["sections"]) for course in courses)
    print(f"Saved {len(courses)} courses and {section_count} sections to {args.output}")


if __name__ == "__main__":
    main()
