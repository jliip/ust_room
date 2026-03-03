"""
UST Empty Room Finder - Schedule Scraper
Scrapes course schedule from https://w5.ab.ust.hk/wcq/cgi-bin/<semester>/
and saves room-indexed schedule to data/schedule.json
"""

import argparse
import json
import re
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

BASE_URL_TEMPLATE = "https://w5.ab.ust.hk/wcq/cgi-bin/{semester}"
DEFAULT_SEMESTER = "2530"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}

# Map 2-letter day codes to full names used in output
DAY_ORDER = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape HKUST room usage data")
    parser.add_argument(
        "--semester",
        default=DEFAULT_SEMESTER,
        help="HKUST semester code (e.g. 2530 for 2025-26 Spring)",
    )
    parser.add_argument(
        "--subjects",
        nargs="+",
        help="Explicit list of subject codes to scrape (e.g. ACCT COMP)",
    )
    parser.add_argument(
        "--subjects-file",
        help="Path to a newline-separated file of subject codes used when the index cannot be fetched",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.3,
        help="Delay between subject requests in seconds (default: 0.3)",
    )
    parser.add_argument(
        "--max-subjects",
        type=int,
        help="Limit the number of subjects scraped (useful for debugging)",
    )
    return parser.parse_args()


def build_base_url(semester: str) -> str:
    code = semester.strip().strip("/") or DEFAULT_SEMESTER
    return BASE_URL_TEMPLATE.format(semester=code)


def normalize_subject_code(code: str) -> str:
    return re.sub(r"\s+", "", code or "").upper()


def load_subject_codes(subjects: list[str] | None, subject_file: str | None) -> list[str]:
    codes: list[str] = []
    if subject_file:
        path = Path(subject_file)
        if not path.exists():
            raise FileNotFoundError(f"Subject list file not found: {subject_file}")
        for line in path.read_text(encoding="utf-8").splitlines():
            cleaned = normalize_subject_code(line)
            if cleaned:
                codes.append(cleaned)
    if subjects:
        for code in subjects:
            cleaned = normalize_subject_code(code)
            if cleaned:
                codes.append(cleaned)
    # Deduplicate while preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for code in codes:
        if code not in seen:
            seen.add(code)
            unique.append(code)
    return unique


def normalize_href(base_url: str, href: str) -> str:
    href = (href or "").strip()
    if not href:
        return ""
    base = base_url if base_url.endswith("/") else base_url + "/"
    return urljoin(base, href)


def get_soup(url: str, retries: int = 3) -> BeautifulSoup:
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=30)
            resp.raise_for_status()
            return BeautifulSoup(resp.text, "html.parser")
        except requests.RequestException as e:
            if attempt == retries - 1:
                raise
            print(f"  Retry {attempt + 1}/{retries} for {url}: {e}")
            time.sleep(2)


def get_subject_links(soup: BeautifulSoup, base_url: str) -> list[str]:
    """Extract all subject page links from the main index page."""
    links = []
    selectors = [
        "a[href]",
        "[data-href]",
        "[data-url]",
        "option[value]",
        "option[data-url]",
    ]
    for selector in selectors:
        for el in soup.select(selector):
            href = (
                el.get("href")
                or el.get("data-href")
                or el.get("data-url")
                or el.get("value")
            )
            if not href or "/subject/" not in href:
                continue
            absolute = normalize_href(base_url, href)
            if absolute and "/subject/" in absolute:
                links.append(absolute.split("#", 1)[0])
    return list(dict.fromkeys(links))  # deduplicate while preserving order


def parse_time(t: str) -> str:
    """Convert '03:00PM' or '15:00' to 'HH:MM' 24h format."""
    t = t.strip()
    if "AM" in t or "PM" in t:
        dt = datetime.strptime(t, "%I:%M%p")
        return dt.strftime("%H:%M")
    return t


def parse_datetime_field(dt_text: str) -> list[dict]:
    """
    Parse the Date & Time field which may contain multiple slots separated by newlines.
    E.g. "WeFr 03:00PM - 04:20PM" or "Mo 09:00AM - 10:20AM\nWe 09:00AM - 10:20AM"
    Returns list of dicts: [{days, start_time, end_time}, ...]
    """
    slots = []
    # Each line can be a separate slot
    for line in dt_text.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        # Pattern: DAY_CODES START - END
        # Day codes: Mo, Tu, We, Th, Fr, Sa, Su (concatenated, e.g. "WeFr" or "MoWeFr")
        match = re.match(
            r"^([A-Z][a-z](?:[A-Z][a-z])*)\s+"
            r"(\d{1,2}:\d{2}(?:AM|PM)?)\s*-\s*(\d{1,2}:\d{2}(?:AM|PM)?)",
            line,
        )
        if not match:
            continue
        days_raw = match.group(1)
        start_raw = match.group(2)
        end_raw = match.group(3)

        # Split day codes into 2-char chunks
        days = re.findall(r"[A-Z][a-z]", days_raw)
        # Keep only known day codes
        days = [d for d in days if d in DAY_ORDER]
        if not days:
            continue

        start_time = parse_time(start_raw)
        end_time = parse_time(end_raw)
        slots.append({"days": days, "start_time": start_time, "end_time": end_time})
    return slots


def parse_int(text: str) -> int:
    text = text.strip()
    try:
        return int(text)
    except ValueError:
        return 0


def scrape_subject(url: str) -> list[dict]:
    """
    Scrape all course sections from a subject page.
    Returns list of section dicts.
    """
    soup = get_soup(url)
    sections = []

    # Each course block has a header with course code/name
    # followed by section rows in a table
    for course_div in soup.select("div.course"):
        # Course code and name are in the heading
        title_el = course_div.select_one("h2") or course_div.select_one(".subject")
        if not title_el:
            continue
        title_text = title_el.get_text(" ", strip=True)
        # e.g. "ISDN 1004 - Sketching"
        title_match = re.match(r"^([A-Z]+\s+\d+\w*)\s*-\s*(.+)$", title_text)
        if title_match:
            course_code = title_match.group(1).strip()
            course_name = title_match.group(2).strip()
        else:
            course_code = title_text
            course_name = ""

        # Section rows
        # Each visible row uses "tr.mainRow"; mobile-friendly detail rows follow but are redundant
        for row in course_div.select("tr.mainRow"):
            cells = row.find_all("td")
            if len(cells) < 8:
                continue

            section_id = cells[0].get_text(strip=True)
            dt_text = cells[1].get_text("\n", strip=True)
            room_text = cells[2].get_text(" ", strip=True)
            instructor_text = cells[3].get_text("; ", strip=True)
            quota_text = cells[4].get_text(strip=True)
            enrol_text = cells[5].get_text(strip=True)
            avail_text = cells[6].get_text(strip=True)
            wait_text = cells[7].get_text(strip=True)

            # Skip if no real room assigned
            room_clean = " ".join(room_text.split())
            if not room_clean or room_clean.upper() in ("TBA", "N/A", "ONLINE", "-"):
                continue
            # Skip purely online or TBA entries
            if re.search(r"\b(TBA|online|zoom)\b", room_clean, re.IGNORECASE):
                continue

            slots = parse_datetime_field(dt_text)
            if not slots:
                continue

            quota = parse_int(quota_text)
            enrol = parse_int(enrol_text)
            avail = parse_int(avail_text)
            wait = parse_int(wait_text)

            for slot in slots:
                sections.append(
                    {
                        "course_code": course_code,
                        "course_name": course_name,
                        "section": section_id,
                        "days": slot["days"],
                        "start_time": slot["start_time"],
                        "end_time": slot["end_time"],
                        "room": room_clean,
                        "instructor": instructor_text,
                        "quota": quota,
                        "enrol": enrol,
                        "avail": avail,
                        "wait": wait,
                    }
                )

    return sections


def build_room_index(all_sections: list[dict]) -> dict:
    """Group sections by room name."""
    rooms: dict[str, list] = {}
    for sec in all_sections:
        room = sec["room"]
        entry = {k: v for k, v in sec.items() if k != "room"}
        rooms.setdefault(room, []).append(entry)
    return rooms


def main():
    args = parse_arguments()
    base_url = build_base_url(args.semester)

    print(f"Scraping UST schedule for semester {args.semester}...")
    print(f"Base URL: {base_url}/")

    # Step 1: resolve subject links, falling back to CLI/file if needed
    print("\n[1/3] Building subject list...")
    subject_links: list[str] = []
    index_error: Exception | None = None
    if not args.subjects and not args.subjects_file:
        try:
            main_soup = get_soup(base_url + "/")
            subject_links = get_subject_links(main_soup, base_url)
        except requests.RequestException as exc:
            index_error = exc
            print(f"  Unable to fetch main index: {exc}")
    if subject_links:
        if args.max_subjects:
            subject_links = subject_links[: args.max_subjects]
        print(f"  Found {len(subject_links)} subjects via site index")
    else:
        fallback_codes = load_subject_codes(args.subjects, args.subjects_file)
        if not fallback_codes:
            msg = ["Could not determine any subject pages."]
            if index_error:
                msg.append(
                    "Pass --subjects/--subjects-file to scrape specific majors when the index is unreachable."
                )
                msg.append(f"Original error: {index_error}")
            raise RuntimeError(" ".join(msg))
        if args.max_subjects:
            fallback_codes = fallback_codes[: args.max_subjects]
        subject_links = [f"{base_url}/subject/{code}" for code in fallback_codes]
        print(f"  Using {len(subject_links)} subject codes supplied via CLI/file")

    # Step 2: scrape each subject
    print("\n[2/3] Scraping subjects...")
    all_sections = []
    for i, url in enumerate(subject_links, 1):
        subject = url.rstrip("/").split("/")[-1]
        print(f"  [{i:3d}/{len(subject_links)}] {subject}", end="", flush=True)
        try:
            secs = scrape_subject(url)
            all_sections.extend(secs)
            print(f" → {len(secs)} sections")
        except Exception as e:
            print(f" → ERROR: {e}")
        if args.delay > 0:
            time.sleep(args.delay)

    print(f"\n  Total sections with rooms: {len(all_sections)}")

    # Step 3: build room index and save
    print("\n[3/3] Building room index and saving...")
    rooms = build_room_index(all_sections)
    print(f"  Unique rooms found: {len(rooms)}")

    output = {
        "scraped_at": datetime.now().isoformat(timespec="seconds"),
        "semester": args.semester,
        "rooms": rooms,
    }

    out_path = Path(__file__).parent / "data" / "schedule.json"
    out_path.parent.mkdir(exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"  Saved to {out_path}")
    print("\nDone!")


if __name__ == "__main__":
    main()
