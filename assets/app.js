const dayOrder = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hkDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Hong_Kong',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const scheduleDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const roomNames = new Intl.Collator('en', { numeric: true });
const millisecondsPerDay = 86_400_000;
const minutesPerDay = 24 * 60;
const pageSize = 8;
const unassignedVenue = /^(?:TBA|TBC|N\/A|[-—])$|\b(?:online|zoom)\b/i;
const locationGroups = [
  ['LSK Building', /\bLSK Bldg\b/i],
  ['CYT Building', /\bCYT Bldg\b/i],
  ['Teaching Hub', /\bTeaching Hub\b/i],
  ['Shaw Auditorium', /\bShaw Auditorium\b/i],
  ['Library', /\bLIB\b/i],
  ['Academic Concourse', /\bAcad Concourse\b/i],
  ['Millennity', /\bMillennity\b/i],
  ['Lecture theaters', /^Lecture Theat(?:er|re)\b/i],
  ['Lift access', /\bLift \d/i],
];

const ui = Object.fromEntries([
  'termLabel', 'hkClock', 'refreshButton', 'statusNote', 'roomSearch', 'clearSearch',
  'locationFilter', 'sortRooms', 'roomsHeading', 'listHeading', 'roomList', 'resultsEmpty',
  'emptyTitle', 'resetFilters', 'resultsFooter', 'resultRange', 'previousPage', 'nextPage',
  'desktopDetail', 'roomDetail', 'detailEmpty', 'detailContent', 'detailDialog', 'closeDetail',
  'detailRoomName', 'detailLocation', 'detailAvailability', 'detailStatus', 'detailChange',
  'detailNote', 'scheduleDate', 'weekDays', 'earlierClasses', 'earlierSummary', 'earlierSlots',
  'timelineSlots', 'scheduleEmpty', 'roomRowTemplate', 'scheduleSlotTemplate',
].map((id) => [id, document.getElementById(id)]));

const availabilityButtons = [...document.querySelectorAll('[data-availability]')];
const compactLayout = window.matchMedia('(max-width: 900px)');
const state = {
  rooms: null,
  hkNow: getHKNow(),
  query: '',
  availability: 'all',
  page: 0,
  selectedRoomId: null,
  selectedDay: null,
};

const dayButtons = dayOrder.map((day, index) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'day-button';
  const label = document.createElement('span');
  label.textContent = dayLabels[index];
  const date = document.createElement('strong');
  button.append(label, date);
  button.addEventListener('click', () => {
    state.selectedDay = day === state.hkNow.dayCode ? null : day;
    renderRoomDetail(selectedRoom());
  });
  return { day, button, date };
});

function init() {
  ui.weekDays.append(...dayButtons.map(({ button }) => button));
  ui.roomSearch.addEventListener('input', updateSearch);
  ui.clearSearch.addEventListener('click', () => {
    ui.roomSearch.value = '';
    updateSearch();
    ui.roomSearch.focus();
  });
  ui.locationFilter.addEventListener('change', resetPage);
  ui.sortRooms.addEventListener('change', resetPage);
  for (const button of availabilityButtons) {
    button.addEventListener('click', () => {
      state.availability = button.dataset.availability;
      resetPage();
    });
  }
  ui.resetFilters.addEventListener('click', () => {
    ui.roomSearch.value = '';
    ui.locationFilter.value = '';
    state.availability = 'all';
    updateSearch();
    ui.roomSearch.focus();
  });
  ui.previousPage.addEventListener('click', () => changePage(-1));
  ui.nextPage.addEventListener('click', () => changePage(1));
  ui.refreshButton.addEventListener('click', () => refreshData(true));
  ui.closeDetail.addEventListener('click', () => ui.detailDialog.close());
  ui.detailDialog.addEventListener('close', restoreInlineDetail);
  compactLayout.addEventListener('change', () => {
    if (!compactLayout.matches && ui.detailDialog.open) ui.detailDialog.close();
    renderResults();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) updateClock();
  });

  updateClock();
  setInterval(updateClock, 30_000);
  refreshData();
}

function updateSearch() {
  state.query = searchKey(ui.roomSearch.value);
  ui.clearSearch.hidden = !ui.roomSearch.value;
  resetPage();
}

function resetPage() {
  state.page = 0;
  renderResults(true);
}

function changePage(offset) {
  state.page += offset;
  renderResults(true);
  if (ui.roomsHeading.getBoundingClientRect().top < 0) {
    ui.roomsHeading.scrollIntoView({ block: 'start' });
  }
}

function updateClock() {
  state.hkNow = getHKNow();
  const { dayCode, weekDates, clock } = state.hkNow;
  ui.hkClock.textContent = clock;
  ui.hkClock.dateTime = `${weekDates[dayCode]}T${clock}:00+08:00`;
  renderResults();
}

async function refreshData(force = false) {
  ui.refreshButton.disabled = true;
  ui.refreshButton.setAttribute('aria-busy', 'true');
  ui.statusNote.textContent = 'Loading schedule…';
  if (!state.rooms) ui.emptyTitle.textContent = 'Loading rooms…';
  try {
    const url = force ? `data/schedule.json?ts=${Date.now()}` : 'data/schedule.json';
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Failed to load schedule (${response.status})`);
    const payload = await response.json();
    const roomsMap = Array.isArray(payload.courses) ? buildRoomIndex(payload.courses) : payload.rooms;
    if (!roomsMap || typeof roomsMap !== 'object' || Array.isArray(roomsMap)) {
      throw new Error('Unrecognized schedule format');
    }
    state.rooms = normalizeRooms(roomsMap);
    const semester = payload.semester_name || `Term ${payload.semester}`;
    ui.termLabel.textContent = `HKUST · ${semester}`;
    const date = payload.scraped_at?.slice(0, 10);
    ui.statusNote.textContent = date ? `Updated ${date}` : 'Schedule loaded';
    populateLocations();
    renderResults(true);
  } catch (error) {
    console.error(error);
    ui.statusNote.textContent = 'Could not refresh the schedule.';
    if (!state.rooms) ui.emptyTitle.textContent = 'Could not load rooms. Try refreshing.';
  } finally {
    ui.refreshButton.disabled = false;
    ui.refreshButton.removeAttribute('aria-busy');
  }
}

function buildRoomIndex(courses) {
  const rooms = Object.create(null);
  for (const course of courses) {
    const units = course.units == null ? '' : ` (${course.units} ${course.units === 1 ? 'unit' : 'units'})`;
    for (const section of course.sections) {
      for (const meeting of section.meetings) {
        const { room, days, start_time, end_time, start_date, end_date, instructors } = meeting;
        if (!room || unassignedVenue.test(room) || !days.length || !start_time || !end_time) {
          continue;
        }
        (rooms[room] ??= []).push({
          course_code: course.code,
          course_name: course.name + units,
          section: `${section.section} (${section.class_number})`,
          days,
          start_time,
          end_time,
          start_date,
          end_date,
          instructor: instructors.join(' · '),
        });
      }
    }
  }
  return rooms;
}

function normalizeRooms(roomsMap) {
  return Object.entries(roomsMap).map(([venue, sections]) => {
    const capacity = venue.match(/\s+\((\d+)\)$/);
    const [name, ...parts] = venue.replace(/\s+\(\d+\)$/, '').split(/,\s*/);
    const location = parts.join(', ');
    const group = locationGroups.find(([, pattern]) => pattern.test(venue))?.[0] || 'Other rooms';
    const description = [location, capacity ? `${capacity[1]} seats` : ''].filter(Boolean).join(' · ');
    const liftLabel = /^Lift ([\d, –-]+)$/i.exec(location)?.[1];
    const liftRanges = liftLabel ? liftLabel.split(',').map((part) => {
      const [first, last = first] = part.split(/[-–]/).map(Number);
      return [first, last];
    }) : [];
    const roomNumber = name.replace(/^Rm /i, '');
    const aliases = [name, roomNumber, name.replace(/^Lecture Theat(?:er|re) /i, 'LT ')].map(searchKey);
    const searchTerms = new Set([
      ...aliases,
      ...[venue, `${name} ${group}`, `${group} ${name}`, `${location.split(/[\s,]/)[0]} ${roomNumber}`].map(searchKey),
    ]);
    const scheduled = sections.map((section) => {
      searchTerms.add(searchKey(section.course_code || ''));
      searchTerms.add(searchKey(section.course_name || ''));
      return {
        ...section,
        startMinutes: parseTimeToMinutes(section.start_time),
        endMinutes: parseTimeToMinutes(section.end_time),
      };
    }).sort((a, b) => a.startMinutes - b.startMinutes);
    return { id: venue, name, description, group, liftRanges, aliases, searchTerms: [...searchTerms], sections: scheduled };
  });
}

function searchKey(value) {
  return value.normalize('NFKC').toLowerCase().replace(/\broom(?=\s|\d|$)/g, 'rm').replace(/[^\p{L}\p{N}]/gu, '');
}

function populateLocations() {
  const current = ui.locationFilter.value;
  const groups = [...new Set(state.rooms.map((room) => room.group))].sort(roomNames.compare);
  ui.locationFilter.replaceChildren(
    new Option('All locations', ''),
    ...groups.map((group) => new Option(group, group)),
  );
  ui.locationFilter.value = groups.includes(current) ? current : '';
}

function renderResults(chooseVisibleRoom = false) {
  if (!state.rooms) return;

  const location = ui.locationFilter.value;
  const lift = /^lift\s*(\d+)$/i.exec(ui.roomSearch.value.normalize('NFKC').trim());
  const liftNumber = lift ? Number(lift[1]) : null;
  const matches = state.rooms
    .filter((room) => !location || room.group === location)
    .filter((room) => roomMatchesSearch(room, liftNumber))
    .map((room) => ({
      room,
      exactRoom: room.aliases.includes(state.query),
      snapshot: buildRoomSnapshot(room, state.hkNow),
    }));
  const free = matches.filter(({ snapshot }) => !snapshot.isBusy);
  const busy = matches.filter(({ snapshot }) => snapshot.isBusy);
  const byStatus = { all: matches, free, busy };
  for (const button of availabilityButtons) {
    const filter = button.dataset.availability;
    button.setAttribute('aria-pressed', String(state.availability === filter));
    button.querySelector('.filter-count').textContent = byStatus[filter].length;
  }

  const results = byStatus[state.availability];
  results.sort((a, b) => {
    if (ui.sortRooms.value === 'availability') {
      const relevance = Number(b.exactRoom) - Number(a.exactRoom);
      const availability = relevance || compareAvailability(a.snapshot, b.snapshot);
      if (availability) return availability;
    }
    return roomNames.compare(a.room.id, b.room.id);
  });
  const pages = Math.max(1, Math.ceil(results.length / pageSize));
  state.page = Math.max(0, Math.min(state.page, pages - 1));
  const start = state.page * pageSize;
  const visible = results.slice(start, start + pageSize);

  if (!state.selectedRoomId || (chooseVisibleRoom && !visible.some(({ room }) => room.id === state.selectedRoomId))) {
    state.selectedRoomId = visible[0]?.room.id ?? null;
  }
  const focusedRoomId = document.activeElement?.closest('.room-row')?.dataset.room;
  ui.roomList.replaceChildren(...visible.map(buildRoomRow));
  if (focusedRoomId) findRoomButton(focusedRoomId)?.focus({ preventScroll: true });

  ui.listHeading.hidden = !results.length;
  ui.resultsFooter.hidden = !results.length;
  ui.resultsEmpty.hidden = Boolean(results.length);
  if (results.length) {
    const first = start + 1;
    const last = start + visible.length;
    const range = first === last ? first : `${first}–${last}`;
    ui.resultRange.textContent = `${range} of ${results.length} ${results.length === 1 ? 'room' : 'rooms'}`;
    ui.previousPage.disabled = state.page === 0;
    ui.nextPage.disabled = state.page >= pages - 1;
  } else {
    ui.emptyTitle.textContent = state.rooms.length ? 'No rooms match these filters.' : 'No rooms in the current schedule.';
    ui.resetFilters.hidden = !state.rooms.length;
  }
  renderRoomDetail(selectedRoom());
}

function roomMatchesSearch(room, lift) {
  if (lift !== null) return room.liftRanges.some(([first, last]) => first <= lift && lift <= last);
  return !state.query || room.searchTerms.some((term) => term.includes(state.query));
}

function compareAvailability(a, b) {
  if (a.isBusy !== b.isBusy) return a.isBusy ? 1 : -1;
  if (a.isBusy) return a.changeMinutes - b.changeMinutes;
  return (b.changeMinutes ?? minutesPerDay) - (a.changeMinutes ?? minutesPerDay);
}

function buildRoomRow({ room, snapshot }) {
  const row = ui.roomRowTemplate.content.firstElementChild.cloneNode(true);
  const button = row.firstElementChild;
  const status = describeAvailability(snapshot, state.hkNow);
  button.dataset.room = room.id;
  button.setAttribute('aria-controls', compactLayout.matches ? 'detailDialog' : 'roomDetail');
  if (compactLayout.matches) button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-current', String(room.id === state.selectedRoomId));
  row.querySelector('.room-name').textContent = room.name;
  row.querySelector('.room-location').textContent = room.description;
  row.querySelector('.status-chip').classList.add(status.kind);
  row.querySelector('.room-status').textContent = status.label;
  row.querySelector('.change-time').textContent = status.change;
  row.querySelector('.change-note').textContent = status.note;
  button.addEventListener('click', () => selectRoom(room));
  return row;
}

function selectedRoom() {
  return state.rooms?.find((room) => room.id === state.selectedRoomId);
}

function findRoomButton(roomId) {
  return [...ui.roomList.querySelectorAll('.room-row')].find((button) => button.dataset.room === roomId);
}

function selectRoom(room) {
  state.selectedRoomId = room.id;
  for (const button of ui.roomList.querySelectorAll('.room-row')) {
    button.setAttribute('aria-current', String(button.dataset.room === room.id));
  }
  renderRoomDetail(room);
  if (compactLayout.matches) {
    ui.detailDialog.append(ui.roomDetail);
    ui.detailDialog.showModal();
  }
}

function restoreInlineDetail() {
  if (ui.detailDialog.open) return;
  ui.desktopDetail.append(ui.roomDetail);
  if (compactLayout.matches) {
    (findRoomButton(state.selectedRoomId) || ui.roomSearch).focus({ preventScroll: true });
  }
}

function buildRoomSnapshot(room, now) {
  const sections = getSectionsForDay(room.sections, now.dayCode, now);
  const current = sections.find((section) => isSectionActive(section, now.minutes));
  if (!current) {
    const next = sections.find((section) => section.startMinutes > now.minutes);
    return { isBusy: false, next, changeMinutes: next?.startMinutes };
  }

  // Overlapping and back-to-back classes keep the room occupied as one block.
  let changeMinutes = current.endMinutes;
  for (const section of sections) {
    if (section.startMinutes > changeMinutes) break;
    changeMinutes = Math.max(changeMinutes, section.endMinutes);
  }
  return { isBusy: true, current, changeMinutes };
}

function describeAvailability(snapshot, now) {
  if (snapshot.isBusy) {
    return {
      kind: 'busy',
      label: 'In use',
      change: `Free at ${formatTime(snapshot.changeMinutes)}`,
      note: `${snapshot.current.course_code} now`,
      detail: `${snapshot.current.course_code} in progress`,
    };
  }
  if (snapshot.next) {
    return {
      kind: 'free',
      label: 'Available',
      change: `Free until ${snapshot.next.start_time}`,
      note: `${formatDuration(snapshot.changeMinutes - now.minutes)} left`,
      detail: `Next class · ${snapshot.next.course_code}`,
    };
  }
  return { kind: 'free', label: 'Available', change: 'Rest of today', note: '', detail: '' };
}

function renderRoomDetail(room) {
  ui.detailEmpty.hidden = Boolean(room);
  ui.detailContent.hidden = !room;
  if (!room) return;

  const now = state.hkNow;
  const status = describeAvailability(buildRoomSnapshot(room, now), now);
  ui.detailRoomName.textContent = room.name;
  ui.detailLocation.textContent = room.description;
  ui.detailAvailability.classList.toggle('busy', status.kind === 'busy');
  ui.detailAvailability.classList.toggle('free', status.kind === 'free');
  ui.detailStatus.textContent = `${status.label} now`;
  ui.detailChange.textContent = status.change;
  ui.detailNote.textContent = status.detail;

  const selectedDay = state.selectedDay ?? now.dayCode;
  const today = selectedDay === now.dayCode;
  const date = now.weekDates[selectedDay];
  const formatted = formatDate(date);
  ui.scheduleDate.textContent = today ? `Today · ${formatted}` : formatted;
  ui.scheduleDate.dateTime = date;
  for (const entry of dayButtons) {
    const day = now.weekDates[entry.day];
    entry.date.textContent = Number(day.slice(-2));
    const label = formatDate(day);
    entry.button.setAttribute('aria-label', entry.day === now.dayCode ? `Today, ${label}` : label);
    entry.button.setAttribute('aria-pressed', String(entry.day === selectedDay));
  }

  const sections = getSectionsForDay(room.sections, selectedDay, now);
  const earlier = today ? sections.filter((section) => section.endMinutes <= now.minutes) : [];
  const upcoming = today ? sections.filter((section) => section.endMinutes > now.minutes) : sections;
  ui.earlierClasses.hidden = !earlier.length;
  ui.earlierSummary.textContent = `${earlier.length} earlier ${earlier.length === 1 ? 'class' : 'classes'}`;
  ui.earlierSlots.replaceChildren(...earlier.map((section) => buildScheduleSlot(section, false)));
  ui.timelineSlots.replaceChildren(...upcoming.map((section) => (
    buildScheduleSlot(section, today && isSectionActive(section, now.minutes))
  )));
  ui.scheduleEmpty.hidden = Boolean(sections.length);
}

function buildScheduleSlot(section, active) {
  const slot = ui.scheduleSlotTemplate.content.firstElementChild.cloneNode(true);
  slot.classList.toggle('is-current', active);
  slot.querySelector('.slot-time').textContent = `${section.start_time}–${section.end_time}`;
  slot.querySelector('.slot-code').textContent = section.course_code;
  slot.querySelector('.slot-now').hidden = !active;
  slot.querySelector('.slot-name').textContent = section.course_name;
  const sectionLabel = section.section ? `Section ${section.section}` : '';
  slot.querySelector('.slot-meta').textContent = [sectionLabel, section.instructor].filter(Boolean).join(' · ');
  return slot;
}

function getSectionsForDay(sections, dayCode, now) {
  const date = now.weekDates[dayCode];
  return sections.filter((section) =>
    section.days.includes(dayCode) &&
    (!section.start_date || section.start_date <= date) &&
    (!section.end_date || date <= section.end_date)
  );
}

function isSectionActive(section, minutesNow) {
  return minutesNow >= section.startMinutes && minutesNow < section.endMinutes;
}

function parseTimeToMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function formatTime(value) {
  const hours = Math.floor(value / 60);
  return `${String(hours).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function formatDuration(value) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return [hours ? `${hours} h` : '', minutes ? `${minutes} min` : ''].filter(Boolean).join(' ');
}

function formatDate(date) {
  return scheduleDate.format(new Date(`${date}T00:00:00Z`));
}

function getHKNow(now = new Date()) {
  const { year, month, day, hour, minute } = Object.fromEntries(
    hkDateTime.formatToParts(now).map(({ type, value }) => [type, value])
  );
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  const dayIndex = (date.getUTCDay() + 6) % 7;
  const monday = date.getTime() - dayIndex * millisecondsPerDay;
  const weekDates = Object.fromEntries(dayOrder.map((code, index) => [
    code,
    new Date(monday + index * millisecondsPerDay).toISOString().slice(0, 10),
  ]));
  return {
    dayCode: dayOrder[dayIndex],
    weekDates,
    clock: `${hour}:${minute}`,
    minutes: Number(hour) * 60 + Number(minute),
  };
}

init();
