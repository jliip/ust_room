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
const weekdayFromIndex = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const state = {
  rooms: [],
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
  try {
    const url = force ? `data/schedule.json?ts=${Date.now()}` : 'data/schedule.json';
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to load schedule (${response.status})`);
    }
    const payload = await response.json();
    state.rooms = normalizeRooms(payload.rooms);
    ui.statusNote.textContent = `Loaded ${state.rooms.length} rooms`;
    renderStatusBoard();
    setInitialRoomSelection();
  } catch (error) {
    console.error(error);
    ui.statusNote.textContent = error.message;
    ui.usingList.innerHTML = `<p class="empty-message">${error.message}</p>`;
    ui.emptyList.innerHTML = '';
  }
}

function showLoading() {
  ui.usingList.innerHTML = '<p class="empty-message">Loading rooms…</p>';
  ui.emptyList.innerHTML = '';
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
  if (!state.rooms.length || !state.hkNow) {
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
  const todaySections = getSectionsForDay(room.sections, now.dayCode);
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
    ? `Live HK time ${formatClock(state.hkNow.date)}`
    : 'Based on selected focus day';

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

  entries.forEach((section) => {
    const slot = document.createElement('div');
    slot.className = 'timeline-slot';
    const isActive = dayCode === state.hkNow.dayCode && isSectionActive(section, state.hkNow.minutes);
    if (isActive) {
      slot.classList.add('active');
    }

    const fillPercent = ((section.endMinutes - section.startMinutes) / (24 * 60)) * 100;

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
    fill.style.setProperty('--fill', `${fillPercent.toFixed(2)}%`);
    bar.appendChild(fill);

    slot.appendChild(header);
    slot.appendChild(course);
    slot.appendChild(seat);
    slot.appendChild(bar);

    ui.timelineSlots.appendChild(slot);
  });
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
    ui.hkClock.textContent = formatClock(state.hkNow.date);
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
  if (state.selectedRoomId && getRoomById(state.selectedRoomId)) {
    renderRoomDetail(getRoomById(state.selectedRoomId));
    highlightSelectedCard();
    return;
  }

  const firstRoom = state.rooms[0];
  if (firstRoom) {
    state.selectedRoomId = firstRoom.id;
    renderRoomDetail(firstRoom);
    highlightSelectedCard();
  }
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

function getSectionsForDay(sections, dayCode) {
  return sections
    .filter((section) => section.days.includes(dayCode))
    .sort((a, b) => a.startMinutes - b.startMinutes);
}

function isSectionActive(section, minutesNow) {
  return minutesNow >= section.startMinutes && minutesNow < section.endMinutes;
}

function formatSeatLine(section) {
  const bits = [];
  if (Number.isFinite(section.enrol)) {
    bits.push(`Enrol ${section.enrol}`);
  }
  if (Number.isFinite(section.avail)) {
    bits.push(`Avail ${section.avail}`);
  }
  if (Number.isFinite(section.wait) && section.wait > 0) {
    bits.push(`Wait ${section.wait}`);
  }
  return bits.length ? bits.join(' • ') : 'Seat data unavailable';
}

function parseTimeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

function formatClock(date) {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

function getHKNow() {
  const hkDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Hong_Kong' }));
  const dayCode = weekdayFromIndex[hkDate.getDay()];
  const minutes = hkDate.getHours() * 60 + hkDate.getMinutes();
  return { date: hkDate, dayCode, minutes };
}

init();
