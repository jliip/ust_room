const dayOrder = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const dayLabels = {
  Mo: 'Monday',
  Tu: 'Tuesday',
  We: 'Wednesday',
  Th: 'Thursday',
  Fr: 'Friday',
  Sa: 'Saturday',
  Su: 'Sunday',
};
const hkDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Hong_Kong',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const millisecondsPerDay = 86_400_000;
const unassignedVenue = /^(?:TBA|TBC|N\/A|[-—])$|\b(?:online|zoom)\b/i;

const state = {
  rooms: null,
  hkNow: getHKNow(),
  selectedRoomId: null,
  selectedDay: null,
  timelineMode: 'today',
  searchQuery: '',
};

const ui = {
  usingList: document.getElementById('usingList'),
  emptyList: document.getElementById('emptyList'),
  usingCount: document.getElementById('usingCount'),
  emptyCount: document.getElementById('emptyCount'),
  termLabel: document.getElementById('termLabel'),
  hkClock: document.getElementById('hkClock'),
  statusNote: document.getElementById('statusNote'),
  detailEmpty: document.getElementById('detailEmptyState'),
  detailContent: document.getElementById('detailContent'),
  detailRoomName: document.getElementById('detailRoomName'),
  detailStatusPill: document.getElementById('detailStatusPill'),
  detailStatusLabel: document.getElementById('detailStatusLabel'),
  detailSubtext: document.getElementById('detailSubtext'),
  detailNextChange: document.getElementById('detailNextChange'),
  detailUpcoming: document.getElementById('detailUpcoming'),
  detailSlotCount: document.getElementById('detailSlotCount'),
  timelineTitle: document.getElementById('timelineTitle'),
  timelineSub: document.getElementById('timelineSub'),
  timelineSlots: document.getElementById('timelineSlots'),
  weekGrid: document.getElementById('weekGrid'),
  daySelect: document.getElementById('daySelect'),
  searchInput: document.getElementById('roomSearch'),
  refreshButton: document.getElementById('refreshButton'),
  timelineMode: document.getElementById('timelineMode'),
};

function init() {
  state.selectedDay = state.hkNow.dayCode;
  populateDaySelect();
  bindEvents();
  showLoading();
  refreshData();
  startClockLoop();
}

function bindEvents() {
  ui.searchInput.addEventListener('input', (event) => {
    state.searchQuery = event.target.value.trim().toLowerCase();
    renderStatusBoard();
  });

  ui.daySelect.addEventListener('change', (event) => {
    state.selectedDay = event.target.value;
    if (state.selectedRoomId) {
      renderRoomDetail(getRoomById(state.selectedRoomId));
    }
  });

  ui.timelineMode.addEventListener('change', (event) => {
    state.timelineMode = event.target.value;
    if (state.selectedRoomId) {
      renderRoomDetail(getRoomById(state.selectedRoomId));
    }
  });

  ui.refreshButton.addEventListener('click', () => {
    ui.statusNote.textContent = 'Refreshing…';
    refreshData(true);
  });
}

async function refreshData(force = false) {
  ui.refreshButton.disabled = true;
  try {
    const url = force ? `data/schedule.json?ts=${Date.now()}` : 'data/schedule.json';
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Failed to load schedule (${response.status})`);
    }
    const payload = await response.json();
    const rooms = Array.isArray(payload.courses) ? buildRoomIndex(payload.courses) : payload.rooms;
    state.rooms = normalizeRooms(rooms);
    const semester = payload.semester_name || `Term ${payload.semester}`;
    ui.termLabel.textContent = `HKUST · ${semester}`;
    const date = payload.scraped_at?.slice(0, 10);
    ui.statusNote.textContent = `${state.rooms.length} rooms${date ? ` · Updated ${date}` : ''}`;
    renderStatusBoard();
    setInitialRoomSelection();
  } catch (error) {
    console.error(error);
    ui.statusNote.textContent = 'Could not load the course schedule.';
    if (!state.rooms) {
      ui.usingList.innerHTML = '<p class="empty-message">Schedule unavailable.</p>';
    }
  } finally {
    ui.refreshButton.disabled = false;
  }
}

function showLoading() {
  ui.usingList.innerHTML = '<p class="empty-message">Loading rooms…</p>';
  ui.emptyList.innerHTML = '';
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
  return Object.entries(roomsMap)
    .map(([name, sections]) => ({
      id: name,
      name,
      slug: name.toLowerCase(),
      sections: sections.map((section) => {
        const startMinutes = parseTimeToMinutes(section.start_time);
        const endMinutes = parseTimeToMinutes(section.end_time);
        return {
          ...section,
          startMinutes,
          endMinutes,
          durationMinutes: endMinutes - startMinutes,
        };
      }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function renderStatusBoard() {
  if (!state.rooms) {
    return;
  }

  const filtered = state.rooms.filter((room) => roomMatchesQuery(room, state.searchQuery));
  const { busy, free } = splitRoomsByStatus(filtered, state.hkNow);

  ui.usingCount.textContent = busy.length;
  ui.emptyCount.textContent = free.length;

  ui.usingList.innerHTML = busy.length ? '' : '<p class="empty-message">No rooms match right now.</p>';
  ui.emptyList.innerHTML = free.length ? '' : '<p class="empty-message">No rooms match right now.</p>';

  busy.forEach(({ room, snapshot }) => ui.usingList.appendChild(buildRoomCard(room, snapshot)));
  free.forEach(({ room, snapshot }) => ui.emptyList.appendChild(buildRoomCard(room, snapshot)));

  highlightSelectedCard();
}

function splitRoomsByStatus(rooms, now) {
  const busy = [];
  const free = [];

  rooms.forEach((room) => {
    const snapshot = buildRoomSnapshot(room, now);
    if (snapshot.isBusy) {
      busy.push({ room, snapshot });
    } else {
      free.push({ room, snapshot });
    }
  });

  const byNextChange = (a, b) => (a.snapshot.nextChangeMinutes ?? Infinity) - (b.snapshot.nextChangeMinutes ?? Infinity);

  busy.sort(byNextChange);
  free.sort(byNextChange);

  return { busy, free };
}

function buildRoomCard(room, snapshot) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'room-card';
  card.dataset.room = room.id;

  const nameEl = document.createElement('div');
  nameEl.className = 'room-name';
  nameEl.textContent = room.name;

  const statusEl = document.createElement('div');
  statusEl.className = 'room-status';
  statusEl.textContent = snapshot.statusLabel;

  const nextEl = document.createElement('div');
  nextEl.className = 'room-next';
  nextEl.textContent = snapshot.nextLine;

  card.appendChild(nameEl);
  card.appendChild(statusEl);
  card.appendChild(nextEl);

  card.addEventListener('click', () => {
    state.selectedRoomId = room.id;
    renderRoomDetail(room);
    highlightSelectedCard();
  });
  return card;
}

function highlightSelectedCard() {
  const cards = document.querySelectorAll('.room-card');
  cards.forEach((node) => {
    if (node.dataset.room === state.selectedRoomId) {
      node.classList.add('selected');
    } else {
      node.classList.remove('selected');
    }
  });
}

function buildRoomSnapshot(room, now) {
  const todaySections = getSectionsForDay(room.sections, now.dayCode, now);
  const current = todaySections.find((section) => isSectionActive(section, now.minutes));
  const next = todaySections.find((section) => section.startMinutes >= now.minutes && section !== current);

  let statusLabel = 'Free all day';
  let nextLine = 'No more classes today';
  let nextChangeMinutes = null;

  if (current) {
    statusLabel = `Busy until ${current.end_time}`;
    nextLine = `${current.course_code} · ${current.start_time} – ${current.end_time}`;
    nextChangeMinutes = current.endMinutes;
  } else if (next) {
    statusLabel = `Free until ${next.start_time}`;
    nextLine = `${next.start_time} · ${next.course_code}`;
    nextChangeMinutes = next.startMinutes;
  }

  return {
    isBusy: Boolean(current),
    statusLabel,
    nextLine,
    nextChangeMinutes,
    todaySections,
    current,
    next,
  };
}

function renderRoomDetail(room) {
  if (!room) {
    ui.detailContent.classList.add('hidden');
    ui.detailEmpty.classList.remove('hidden');
    return;
  }

  const snapshot = buildRoomSnapshot(room, state.hkNow);
  const isBusy = snapshot.isBusy;

  ui.detailRoomName.textContent = room.name;
  ui.detailStatusPill.textContent = isBusy ? 'In use' : 'Empty now';
  ui.detailStatusPill.classList.toggle('busy', isBusy);
  ui.detailStatusPill.classList.toggle('free', !isBusy);
  ui.detailStatusLabel.textContent = isBusy ? `Occupied until ${snapshot.current?.end_time}` : 'Available to occupy';
  ui.detailSubtext.textContent = snapshot.nextLine;
  ui.detailNextChange.textContent = isBusy
    ? `Vacant at ${snapshot.current?.end_time}`
    : snapshot.next
      ? `Next class kicks off at ${snapshot.next.start_time}`
      : 'Free for the rest of the day';
  ui.detailUpcoming.textContent = snapshot.next
    ? `${snapshot.next.course_code} · ${snapshot.next.start_time} – ${snapshot.next.end_time}`
    : snapshot.current
      ? `${snapshot.current.course_code} happening now`
      : 'No remaining bookings today';

  const timelineDay = state.timelineMode === 'today' ? state.hkNow.dayCode : state.selectedDay;
  const timelineTitleLabel = state.timelineMode === 'today' ? `Today · ${dayLabels[state.hkNow.dayCode]}` : `${dayLabels[timelineDay]} timeline`;
  ui.timelineTitle.textContent = timelineTitleLabel;
  ui.timelineSub.textContent = state.timelineMode === 'today'
    ? `Live HK time ${state.hkNow.clock}`
    : `${state.hkNow.weekDates[timelineDay]} · HK time`;

  renderTimeline(room, timelineDay);
  renderWeekGrid(room);

  const slotsToday = getSectionsForDay(room.sections, timelineDay).length;
  ui.detailSlotCount.textContent = `${slotsToday} slot${slotsToday === 1 ? '' : 's'}`;

  ui.detailEmpty.classList.add('hidden');
  ui.detailContent.classList.remove('hidden');
}

function renderTimeline(room, dayCode) {
  const entries = getSectionsForDay(room.sections, dayCode);
  ui.timelineSlots.innerHTML = '';

  if (!entries.length) {
    ui.timelineSlots.innerHTML = '<p class="timeline-empty">Room stays free this day.</p>';
    return;
  }

  const showLiveProgress = state.timelineMode === 'today' && dayCode === state.hkNow.dayCode;

  entries.forEach((section) => {
    const slot = document.createElement('div');
    slot.className = 'timeline-slot';
    const isActive = dayCode === state.hkNow.dayCode && isSectionActive(section, state.hkNow.minutes);
    if (isActive) {
      slot.classList.add('active');
    }

    const widthPercent = showLiveProgress
      ? getSectionProgressPercent(section, state.hkNow.minutes)
      : ((section.endMinutes - section.startMinutes) / (24 * 60)) * 100;

    const header = document.createElement('div');
    header.className = 'slot-header';
    const time = document.createElement('span');
    time.textContent = `${section.start_time} – ${section.end_time}`;
    const instructor = document.createElement('span');
    instructor.textContent = section.instructor || '';
    header.appendChild(time);
    header.appendChild(instructor);

    const course = document.createElement('p');
    course.className = 'slot-course';
    course.textContent = `${section.course_code} · ${section.course_name}`;

    const seat = document.createElement('p');
    seat.className = 'room-status';
    seat.textContent = formatSeatLine(section);

    const bar = document.createElement('div');
    bar.className = 'slot-bar';
    const fill = document.createElement('span');
    fill.style.setProperty('--fill', `${widthPercent.toFixed(2)}%`);
    bar.appendChild(fill);

    slot.appendChild(header);
    slot.appendChild(course);
    slot.appendChild(seat);
    slot.appendChild(bar);

    ui.timelineSlots.appendChild(slot);
  });
}

function getSectionProgressPercent(section, minutesNow) {
  if (!Number.isFinite(section.durationMinutes) || section.durationMinutes <= 0) {
    return minutesNow >= section.endMinutes ? 100 : 0;
  }
  if (minutesNow <= section.startMinutes) {
    return 0;
  }
  if (minutesNow >= section.endMinutes) {
    return 100;
  }
  const elapsed = minutesNow - section.startMinutes;
  const percent = (elapsed / section.durationMinutes) * 100;
  return Math.min(Math.max(percent, 0), 100);
}

function renderWeekGrid(room) {
  ui.weekGrid.innerHTML = '';
  dayOrder.forEach((code) => {
    const dayLabel = dayLabels[code];
    const slotWrap = document.createElement('div');
    slotWrap.className = 'week-slots';
    const daySections = getSectionsForDay(room.sections, code);

    if (!daySections.length) {
      const chip = document.createElement('span');
      chip.className = 'week-chip';
      chip.textContent = 'Free';
      slotWrap.appendChild(chip);
    } else {
      daySections.forEach((section) => {
        const chip = document.createElement('span');
        chip.className = 'week-chip busy';
        chip.textContent = `${section.start_time} · ${section.course_code}`;
        slotWrap.appendChild(chip);
      });
    }

    const dayName = document.createElement('div');
    dayName.className = 'week-day';
    dayName.textContent = dayLabel;

    ui.weekGrid.appendChild(dayName);
    ui.weekGrid.appendChild(slotWrap);
  });
}

function populateDaySelect() {
  dayOrder.forEach((code) => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = dayLabels[code];
    if (code === state.selectedDay) {
      option.selected = true;
    }
    ui.daySelect.appendChild(option);
  });
}

function startClockLoop() {
  const tick = () => {
    state.hkNow = getHKNow();
    ui.hkClock.textContent = state.hkNow.clock;
    renderStatusBoard();
    if (state.selectedRoomId) {
      renderRoomDetail(getRoomById(state.selectedRoomId));
    }
  };

  tick();
  setInterval(tick, 60_000);
}

function getRoomById(id) {
  return state.rooms.find((room) => room.id === id);
}

function setInitialRoomSelection() {
  const room = getRoomById(state.selectedRoomId) || state.rooms[0];
  state.selectedRoomId = room?.id ?? null;
  renderRoomDetail(room);
  highlightSelectedCard();
}

function roomMatchesQuery(room, query) {
  if (!query) {
    return true;
  }
  const lower = query.toLowerCase();
  if (room.slug.includes(lower)) {
    return true;
  }
  return room.sections.some((section) =>
    (section.course_code || '').toLowerCase().includes(lower) || (section.course_name || '').toLowerCase().includes(lower)
  );
}

function getSectionsForDay(sections, dayCode, now = state.hkNow) {
  const date = now.weekDates[dayCode];
  return sections
    .filter((section) =>
      section.days.includes(dayCode) &&
      (!section.start_date || section.start_date <= date) &&
      (!section.end_date || date <= section.end_date)
    )
    .sort((a, b) => a.startMinutes - b.startMinutes);
}

function isSectionActive(section, minutesNow) {
  return minutesNow >= section.startMinutes && minutesNow < section.endMinutes;
}

function formatSeatLine(section) {
  if (section.section) {
    return `Section ${section.section}`;
  }
  if (section.course_code) {
    return `Section info · ${section.course_code}`;
  }
  return 'Section info unavailable';
}

function parseTimeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
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
