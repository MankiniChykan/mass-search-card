/**
 * @customElement
 * @cardType mass-search-card
 * @description Search and play media using Music Assistant in Home Assistant
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Full change log & design notes vs. original (comprehensive):
 *
 * 1) Structure & DOM safety
 *    - All UI is rendered inside the component’s shadow DOM; nothing is appended
 *      to document.body (prevents global leaks, z-index battles, and HA theming issues).
 *    - Single render pass with stable references kept in `this.refs` to avoid
 *      brittle selectors and accidental null refs after re-renders.
 *    - <style> is injected once per render and not removed unexpectedly; styles
 *      remain intact across state updates.
 *    - Popup overlay is also in the shadow DOM and cleaned up on close.
 *
 * 2) State management & config access
 *    - Selected media player (`selectedMediaPlayer`), selected media type
 *      (`selectedMediaType`), and result limit (`selectedLimit`, default 20,
 *      range 0–60) are stored on the instance and reused between interactions.
 *    - `configEntryId` for `music_assistant` is fetched once via `callApi('GET',
 *      'config/config_entries/entry')`, cached, and reused.
 *    - Media player list is rebuilt on `set hass(...)` so the dropdown reflects
 *      current entities and friendly names.
 *
 * 3) Internationalization & labels
 *    - Unified translations; removed duplicate “cz” map and use “cs” (Czech).
 *    - All visible strings run through the selected translation table (auto-detect
 *      from `this.hass?.language` with fallback to `en`).
 *    - Search placeholder, dropdown labels, buttons, and result metadata are localized.
 *
 * 4) Inputs & controls (UX)
 *    - Search field triggers a debounced search (500ms) on Enter key or search
 *      button click; consistent behavior for keyboard and mouse.
 *    - “Number of results” is now a dropdown with values 0–60; default is 20;
 *      the button label shows “Number of results: N”.
 *    - “Local library” toggle uses a pill-style control that scales with the card.
 *    - Media type dropdown provides: Artist / Track / Album / Playlist / Radio.
 *    - Media player dropdown lists only MASS-enabled media_player entities
 *      (`attributes.mass_player_type` truthy).
 *    - All dropdowns support outside-click and ESC to close (bound/unbound in lifecycle).
 *
 * 5) Anti-spam & concurrency
 *    - Debounced search (500ms) + in-flight lock prevents multiple overlapping
 *      backend searches from rapid input or repeat clicks.
 *    - While searching, the search button is disabled and shows a spinner.
 *    - Each result row’s “play” action is click-throttled: button disables and
 *      shows a mini spinner briefly, then re-enables (prevents rapid-fire
 *      service calls).
 *
 * 6) Service call robustness
 *    - Primary path uses `this._hass.callService('music_assistant','search', payload,
 *      { return_response: true })`.
 *    - Fallback path uses `this._hass.connection.sendMessagePromise(...)` with
 *      `return_response: true` to handle supervisor/driver differences.
 *    - `play_media` calls are guarded (no call if player/type/uri is missing).
 *    - Errors surface to the user with a HA persistent notification toast.
 *
 * 7) Security & content safety
 *    - No user text is injected with `innerHTML`; we always use `textContent`.
 *    - Images are HTTPS-only; non-HTTPS or invalid image URLs fallback to a safe
 *      inline avatar SVG (prevents mixed-content warnings).
 *    - No untrusted HTML is rendered anywhere.
 *
 * 8) Layout & responsiveness
 *    - All main controls (search pill, both dropdowns, results dropdown, library
 *      toggle) are fluid with `flex: 1 1 160px; min-width: 0;` to allow shrinking
 *      without overflow when the Lovelace column is narrow or “squashed”.
 *    - Text elements use `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`
 *      to avoid overflow into adjacent controls.
 *    - The popup uses `width: min(420px, 92vw)` to fit small screens; max-height
 *      is constrained with scroll.
 *    - Provider icons (Spotify/YouTube Music/Library) shrink slightly on mobile.
 *
 * 9) Visual & accessibility details
 *    - Clear, consistent pill styles, border radii and focusless inputs to match
 *      HA card look-and-feel.
 *    - Title area includes an inline gradient note icon (SVG data URI) for zero
 *      network dependencies.
 *    - Result rows include artwork, primary text, secondary metadata, and provider
 *      badges with per-item play throttling.
 *
 * 10) Icons & assets
 *     - All icons (logo, provider badges, fallback avatar) are inline SVG data URIs.
 *       No external requests, no CSP headaches.
 *
 * 11) Code hygiene & lifecycle
 *     - Global listeners (outside-click, ESC) are attached in `_wireStaticHandlers`
 *       and removed in `disconnectedCallback`.
 *     - Separation of concerns: `render()` (DOM), `_wireStaticHandlers()` (events),
 *       `_runSearch()` (logic), `_showPopup()` (results), small helpers for UI pieces.
 *
 * 12) Differences fixed vs original overflow bugs
 *     - “Select a media player” and “Media type” dropdowns now shrink with the
 *       card (no overflow/overlap in sections).
 *     - “Local library” pill no longer overflows; it truncates gracefully.
 *     - Results dropdown (0–60) is fluid and truncates its label if needed.
 *
 * 13) Misc
 *     - Enter submits; ESC closes dropdowns; outside-click closes dropdowns.
 *     - Card size hint kept at 8.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 */

class MassSearchCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    // State
    this._hass = null;
    this.mediaPlayerEntities = [];
    this.configEntryId = '';
    this.selectedMediaPlayer = null;
    this.selectedMediaType = '';
    this.selectedLimit = 20; // default results count (0–60)
    this._inFlightSearch = false;
    this._searchDebounceTimer = null;

    // UI refs
    this.refs = {};
  }

  async setConfig(config) {
    this.config = config || {};

    const translations = {
      nl:{album_label:'Album',artist_label:'Artiest',close_button:'Sluiten',dropdown_label_media_player:'Selecteer een media player',error_fetching:'Er is een fout opgetreden bij het ophalen van de resultaten.',library_only_label:'Lokaal',media_type:'Soort media',no_results:'Geen resultaten gevonden.',playing_media:'Media afgespeeld:',playlist_label:'Afspeellijst',popup_title:'Zoekresultaten voor:',radio_label:'Radio',results_label:'Aantal resultaten',search_button:'Zoeken',search_placeholder:'Typ hier je zoekterm...',select_media_type:'Selecteer media type',title_text:'Zoek in Music Assistant',track_label:'Nummer',unknown_artist:'Onbekende artiest',unknown_duration:'Onbekende duur'},
      cs:{album_label:'Album',artist_label:'Umělec',close_button:'Zavřít',dropdown_label_media_player:'Vyberte přehrávač médií',error_fetching:'Při načítání výsledků došlo k chybě.',library_only_label:'Pouze knihovna',media_type:'Typ média',no_results:'Nebyly nalezeny žádné výsledky.',playing_media:'Přehrané médium:',playlist_label:'Seznam skladeb',popup_title:'Výsledky hledání pro:',radio_label:'Rádio',results_label:'Počet výsledků',search_button:'Hledat',search_placeholder:'Zadejte hledaný výraz...',select_media_type:'Vyberte typ média',title_text:'Hledat v Music Assistant',track_label:'Skladba',unknown_artist:'Neznámý umělec',unknown_duration:'Neznámá délka'},
      en:{album_label:'Album',artist_label:'Artist',close_button:'Close',dropdown_label_media_player:'Select a media player',error_fetching:'An error occurred while fetching results.',library_only_label:'Local library',media_type:'Media type',no_results:'No results found.',playing_media:'Media played:',playlist_label:'Playlist',popup_title:'Search Results for:',radio_label:'Radio',results_label:'Number of results',search_button:'Search',search_placeholder:'Type your search term here...',select_media_type:'Select media type',title_text:'Search in Music Assistant',track_label:'Track',unknown_artist:'Unknown artist',unknown_duration:'Unknown duration'},
      sv:{album_label:'Album',artist_label:'Artist',close_button:'Stäng',dropdown_label_media_player:'Välj mediaspelare',error_fetching:'Ett fel uppstod när resultat hämtades.',library_only_label:'Endast bibliotek',media_type:'Mediatyp',no_results:'Inga resultat funna.',playing_media:'Media spelad:',playlist_label:'Spellista',popup_title:'Sökresultat för:',radio_label:'Radio',results_label:'Antal resultat',search_button:'Sök',search_placeholder:'Sök här…',select_media_type:'Välj mediatyp',title_text:'Sök i Music Assistant',track_label:'Spår',unknown_artist:'Okänd artist',unknown_duration:'Okänd varaktighet'},
    };

    const language = this.config.language || this.hass?.language || 'en';
    this.t = translations[language] || translations.en;

    this.render();
    this._wireStaticHandlers();
  }

  // ====== Rendering ======
  render() {
    const style = document.createElement('style');
    style.textContent = `
      :host { display:block; min-width:0; }
      .wrapper {
        display:flex; flex-direction:column; gap:16px;
        border:1px solid var(--primary-color); border-radius:16px;
        background:var(--card-background-color); padding:16px;
        box-sizing:border-box; width:100%; box-shadow:0 4px 6px rgba(0,0,0,.1); min-width:0;
      }
      .title-row { display:flex; align-items:center; gap:16px; min-width:0; }
      .title-row img { width:56px; border-radius:8px; flex:0 0 auto; }
      .title-text { font-size:22px; font-weight:700; color:var(--primary-text-color); min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

      .row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; min-width:0; }
      .pill {
        display:flex; align-items:center; gap:8px; min-width:0;
        border:1px solid var(--primary-color); border-radius:24px;
        padding:8px 12px; height:48px; background:var(--card-background-color);
      }
      .input { flex:1 1 160px; min-width:0; border:none; outline:none; background:transparent; color:var(--primary-text-color); font-size:16px; }

      .icon-btn { cursor:pointer; border:none; background:transparent; font-size:18px; color:var(--primary-text-color); flex:0 0 auto; }
      .icon-btn[disabled] { opacity:.5; cursor:not-allowed; }

      .spinner, .spinner-mini { width:18px; height:18px; border:2px solid rgba(255,255,255,.2); border-top-color:var(--primary-color); border-radius:50%; animation:spin .8s linear infinite; }
      .spinner-mini { width:14px; height:14px; border-width:2px; }
      @keyframes spin { to { transform: rotate(360deg); } }

      /* Fluid dropdowns (media player, media type, results count) */
      .dropdown { position:relative; flex:1 1 160px; min-width:0; }
      .dropdown-btn {
        width:100%; min-width:0; display:flex; align-items:center; justify-content:space-between;
        cursor:pointer; border:1px solid var(--primary-color); border-radius:8px;
        padding:8px; background:var(--card-background-color); color:var(--primary-text-color);
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .dropdown-list {
        position:absolute; top:calc(100% + 6px); left:0; width:100%; max-height:280px; overflow:auto; display:none; z-index:10;
        border:1px solid var(--primary-color); border-radius:8px; background:var(--card-background-color); box-shadow:0 4px 6px rgba(0,0,0,.1);
      }
      .dropdown.open .dropdown-list { display:block; }
      .dropdown-item { padding:8px; cursor:pointer; border-bottom:1px solid var(--divider-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .dropdown-item:hover { background:rgba(255,165,0,.25); }

      .checkbox-pill { flex:1 1 160px; min-width:0; }
      .checkbox-pill label { font-size:14px; color:var(--primary-text-color); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

      .overlay { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.5); z-index:9999; }
      .popup { background:var(--card-background-color); border-radius:24px; width:min(420px,92vw); max-height:80vh; overflow:auto; padding:16px; box-shadow:0 4px 6px rgba(0,0,0,.1); }
      .popup h2 { margin:0 0 12px 0; color:var(--primary-text-color); font-size:18px; }

      .result-btn { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; padding:8px; margin:8px 0; border:1px solid var(--primary-color); border-radius:24px; background:var(--card-background-color); color:var(--primary-text-color); cursor:pointer; }
      .result-btn[disabled] { opacity:.6; cursor:not-allowed; }
      .image-wrap { width:44px; height:44px; border-radius:50%; overflow:hidden; display:flex; align-items:center; justify-content:center; flex:0 0 auto; }
      .image-wrap img { width:44px; height:44px; object-fit:cover; border-radius:50%; }

      .text-wrap { flex:1 1 auto; min-width:0; text-align:center; display:flex; flex-direction:column; align-items:center; justify-content:center; }
      .text-primary, .text-secondary { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
      .text-primary { font-weight:700; }
      .text-secondary { font-size:12px; opacity:.8; }

      .provider-icons { display:flex; gap:6px; min-width:44px; justify-content:center; }
      .provider-icons img { width:24px; height:24px; }
      .mini-wrap { min-width:18px; display:flex; align-items:center; justify-content:center; }

      .close-btn { margin-top:12px; padding:8px 16px; border:none; border-radius:24px; background:var(--primary-color); color:var(--card-background-color); cursor:pointer; }

      @media (max-width:600px){
        .pill, .dropdown, .dropdown-btn, .row { width:100%; }
        .provider-icons img { width:20px; height:20px; }
      }
    `;

    const wrapper = document.createElement('div');
    wrapper.className = 'wrapper';

    // Title
    const titleRow = document.createElement('div');
    titleRow.className = 'title-row';
    const logo = document.createElement('img');
    logo.alt = 'Music Assistant';
    logo.src = this._logoDataURI();
    const titleText = document.createElement('span');
    titleText.className = 'title-text';
    titleText.textContent = this.t.title_text;
    titleRow.appendChild(logo);
    titleRow.appendChild(titleText);

    // Search
    const inputRow = document.createElement('div');
    inputRow.className = 'row';
    const inputPill = document.createElement('div');
    inputPill.className = 'pill';
    const input = document.createElement('input');
    input.className = 'input';
    input.type = 'text';
    input.placeholder = this.t.search_placeholder;
    const searchSpinner = document.createElement('div');
    searchSpinner.className = 'spinner';
    searchSpinner.style.display = 'none';
    const searchBtn = document.createElement('button');
    searchBtn.className = 'icon-btn';
    searchBtn.title = this.t.search_button;
    searchBtn.textContent = '🔍';
    inputPill.appendChild(input);
    inputPill.appendChild(searchSpinner);
    inputPill.appendChild(searchBtn);
    inputRow.appendChild(inputPill);

    // Settings row: results dropdown + local library
    const settingsRow = document.createElement('div');
    settingsRow.className = 'row';

    const resultsDrop = this._createDropdown(this.t.results_label);
    for (let n = 0; n <= 60; n++) {
      const item = this._createDropdownItem(String(n), () => {
        this.selectedLimit = n;
        resultsDrop.btn.textContent = `${this.t.results_label}: ${n} ▼`;
        resultsDrop.root.classList.remove('open');
      });
      resultsDrop.list.appendChild(item);
    }
    resultsDrop.btn.textContent = `${this.t.results_label}: ${this.selectedLimit} ▼`;

    const libraryPill = document.createElement('div');
    libraryPill.className = 'pill checkbox-pill';
    const libraryCheckbox = document.createElement('input');
    libraryCheckbox.type = 'checkbox';
    const libraryLabel = document.createElement('label');
    libraryLabel.textContent = this.t.library_only_label;
    libraryPill.appendChild(libraryCheckbox);
    libraryPill.appendChild(libraryLabel);

    settingsRow.appendChild(resultsDrop.root);
    settingsRow.appendChild(libraryPill);

    // Control row: player dropdown + media type dropdown
    const controlRow = document.createElement('div');
    controlRow.className = 'row';
    const toolPill = document.createElement('div');
    toolPill.className = 'pill';
    const toolIcon = document.createElement('ha-icon');
    toolIcon.setAttribute('icon', 'mdi:hammer-wrench');
    toolIcon.style.color = 'var(--primary-color)';
    toolPill.appendChild(toolIcon);

    const playerDrop = this._createDropdown(this.t.dropdown_label_media_player);
    const mediaTypeDrop = this._createDropdown(this.t.media_type);

    [
      { value: 'artist', label: this.t.artist_label },
      { value: 'track', label: this.t.track_label },
      { value: 'album', label: this.t.album_label || 'Album' },
      { value: 'playlist', label: this.t.playlist_label },
      { value: 'radio', label: this.t.radio_label || 'Radio' },
    ].forEach((opt) => {
      const item = this._createDropdownItem(opt.label, () => {
        this.selectedMediaType = opt.value;
        mediaTypeDrop.btn.textContent = opt.label + ' ▼';
        mediaTypeDrop.root.classList.remove('open');
      });
      mediaTypeDrop.list.appendChild(item);
    });

    controlRow.appendChild(toolPill);
    controlRow.appendChild(playerDrop.root);
    controlRow.appendChild(mediaTypeDrop.root);

    // Assemble
    wrapper.appendChild(titleRow);
    wrapper.appendChild(inputRow);
    wrapper.appendChild(settingsRow);
    wrapper.appendChild(controlRow);

    // Mount
    this.shadowRoot.innerHTML = '';
    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(wrapper);

    // Refs
    this.refs = {
      input,
      searchBtn,
      searchSpinner,
      resultsDrop,
      libraryCheckbox,
      playerDrop,
      mediaTypeDrop,
      wrapper,
    };
  }

  // ====== Events ======
  _wireStaticHandlers() {
    const { input, searchBtn } = this.refs;
    const triggerSearch = () => this._debounce(() => this._runSearch(), 500);
    searchBtn.addEventListener('click', () => triggerSearch());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') triggerSearch(); });

    document.addEventListener('click', this._outsideCloseHandler);
    document.addEventListener('keydown', this._escCloseHandler);
  }

  disconnectedCallback() {
    document.removeEventListener('click', this._outsideCloseHandler);
    document.removeEventListener('keydown', this._escCloseHandler);
  }
  _outsideCloseHandler = (e) => {
    const drops = this.shadowRoot.querySelectorAll('.dropdown.open');
    drops.forEach((d) => { if (!d.contains(e.target)) d.classList.remove('open'); });
  };
  _escCloseHandler = (e) => {
    if (e.key === 'Escape') this.shadowRoot.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open'));
  };

  // ====== Logic ======
  async _runSearch() {
    if (!this._hass) return;
    if (this._inFlightSearch) return;

    const { input, searchBtn, searchSpinner, libraryCheckbox } = this.refs;
    const query = (input.value || '').trim();
    const limit = Math.max(0, Math.min(parseInt(this.selectedLimit ?? 20, 10), 60));
    const libraryOnly = !!libraryCheckbox.checked;

    if (!this.selectedMediaPlayer) { this._toast(this.t.dropdown_label_media_player); return; }
    if (!this.selectedMediaType) { this._toast(this.t.select_media_type); return; }
    if (!query) return;

    const title = `${this.t.popup_title} "${query}" (${this.selectedMediaType})`;
    const payload = { name: query, media_type: this.selectedMediaType, config_entry_id: this.configEntryId, limit, library_only: libraryOnly };

    // Lock + spinner
    this._inFlightSearch = true;
    const oldBtnText = searchBtn.textContent;
    searchBtn.setAttribute('disabled', 'true');
    searchBtn.textContent = '';
    searchSpinner.style.display = 'inline-block';

    try {
      const response = await this._hass.callService('music_assistant', 'search', payload, { return_response: true });
      const data = response || await this._hass.connection.sendMessagePromise({
        type: 'call_service', domain: 'music_assistant', service: 'search', service_data: payload, return_response: true,
      });
      this._showPopup(data, title);
    } catch (err) {
      this._toast(this.t.error_fetching);
      console.error('Music Assistant search error:', err);
    } finally {
      this._inFlightSearch = false;
      searchSpinner.style.display = 'none';
      searchBtn.textContent = oldBtnText || '🔍';
      searchBtn.removeAttribute('disabled');
    }
  }

  _showPopup(response, title) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    const popup = document.createElement('div');
    popup.className = 'popup';

    const h2 = document.createElement('h2');
    h2.textContent = title;
    popup.appendChild(h2);

    const results = (response?.response?.artists || [])
      .concat(response?.response?.tracks || [])
      .concat(response?.response?.albums || [])
      .concat(response?.response?.radio || [])
      .concat(response?.response?.playlists || []);

    if (!results || results.length === 0) {
      const p = document.createElement('p');
      p.textContent = this.t.no_results;
      p.style.color = 'var(--primary-text-color)';
      popup.appendChild(p);
    } else {
      results.forEach((item) => popup.appendChild(this._resultButton(item)));
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.textContent = this.t.close_button;
    closeBtn.addEventListener('click', () => { if (overlay.parentElement) overlay.parentElement.removeChild(overlay); });

    popup.appendChild(closeBtn);
    overlay.appendChild(popup);
    this.shadowRoot.appendChild(overlay);
  }

  _resultButton(mediaItem) {
    const btn = document.createElement('button');
    btn.className = 'result-btn';

    const imgWrap = document.createElement('div');
    imgWrap.className = 'image-wrap';
    const img = document.createElement('img');
    img.src = this._safeImage(mediaItem?.image);
    img.alt = mediaItem?.name || 'item';
    imgWrap.appendChild(img);

    const textWrap = document.createElement('div');
    textWrap.className = 'text-wrap';
    const title = document.createElement('div');
    title.className = 'text-primary';
    title.textContent = mediaItem?.name || '—';

    const uri = mediaItem?.uri || '';
    const isTrack = uri.includes('track');
    const isArtist = uri.includes('artist');
    const isRadio = uri.includes('radio');
    const isPlaylist = uri.includes('playlist');

    const artistName = mediaItem?.artists?.[0]?.name ||
      (isRadio ? this.t.radio_label : isPlaylist ? this.t.playlist_label : this.t.unknown_artist);

    const secondary = document.createElement('div');
    secondary.className = 'text-secondary';
    if (isTrack) {
      const albumName = mediaItem?.album?.name || '';
      secondary.textContent = `${artistName}${albumName ? ` • ${albumName}` : ''}`;
    } else if (isArtist) {
      secondary.textContent = '';
    } else {
      secondary.textContent = artistName;
    }

    textWrap.appendChild(title);
    if (secondary.textContent) textWrap.appendChild(secondary);

    const providers = document.createElement('div');
    providers.className = 'provider-icons';
    this._providerIcons(uri).forEach((i) => providers.appendChild(i));

    const miniWrap = document.createElement('div');
    miniWrap.className = 'mini-wrap';

    btn.appendChild(imgWrap);
    btn.appendChild(textWrap);
    btn.appendChild(providers);
    btn.appendChild(miniWrap);

    btn.addEventListener('click', async () => {
      if (!this.selectedMediaPlayer || !this.selectedMediaType || !uri) return;
      if (btn.hasAttribute('disabled')) return;
      btn.setAttribute('disabled', 'true');

      const mini = document.createElement('div');
      mini.className = 'spinner-mini';
      miniWrap.innerHTML = '';
      miniWrap.appendChild(mini);

      try {
        await this._hass.callService('music_assistant', 'play_media', {
          entity_id: this.selectedMediaPlayer,
          media_type: this.selectedMediaType,
          media_id: uri,
        });
      } catch (e) {
        this._toast(this.t.error_fetching);
        console.error('play_media error:', e);
      } finally {
        setTimeout(() => { btn.removeAttribute('disabled'); miniWrap.innerHTML = ''; }, 700);
      }
    });

    return btn;
  }

  // ====== Helpers ======
  _createDropdown(labelText) {
    const root = document.createElement('div');
    root.className = 'dropdown';
    const btn = document.createElement('button');
    btn.className = 'dropdown-btn';
    btn.textContent = `${labelText} ▼`;
    const list = document.createElement('div');
    list.className = 'dropdown-list';
    btn.addEventListener('click', (e) => { e.stopPropagation(); root.classList.toggle('open'); });
    root.appendChild(btn);
    root.appendChild(list);
    return { root, btn, list };
  }
  _createDropdownItem(text, onClick) {
    const item = document.createElement('div');
    item.className = 'dropdown-item';
    item.textContent = text;
    item.title = text;
    item.addEventListener('click', (e) => { e.stopPropagation(); onClick?.(); });
    return item;
  }

  _providerIcons(uri='') {
    const icons = [];
    const addImg = (src, alt) => { const i=document.createElement('img'); i.src=src; i.alt=alt; return i; };
    if (uri.includes('ytmusic')) icons.push(addImg(this._ytmIcon(),'YouTube Music'));
    if (uri.includes('spotify')) icons.push(addImg(this._spotifyIcon(),'Spotify'));
    if (uri.includes('library')) icons.push(addImg(this._libraryIcon(),'Library'));
    if (icons.length===0) icons.push(addImg(this._libraryIcon(),'Media'));
    return icons;
  }

  _safeImage(url) {
    const FALLBACK = this._fallbackAvatar();
    if (!url) return FALLBACK;
    try { if (!/^https:\/\//i.test(url)) return FALLBACK; return url; } catch { return FALLBACK; }
  }
  _debounce(fn, ms){ clearTimeout(this._searchDebounceTimer); this._searchDebounceTimer=setTimeout(()=>fn(), ms); }
  _toast(message){ try{ this._hass.callService('persistent_notification','create',{title:'Music Assistant',message}); }catch{} }

  // ====== HA wires ======
  set hass(hass) {
    this._hass = hass;

    this.mediaPlayerEntities = Object.keys(hass.states)
      .filter((id)=> id.startsWith('media_player.') && hass.states[id]?.attributes?.mass_player_type)
      .map((id)=> ({ entity_id:id, name:hass.states[id].attributes.friendly_name || id }));

    const playerList = this.refs?.playerDrop?.list;
    const playerBtn = this.refs?.playerDrop?.btn;
    if (playerList && playerBtn) {
      playerList.innerHTML = '';
      if (this.mediaPlayerEntities.length) {
        this.mediaPlayerEntities.forEach((ent)=>{
          const item = this._createDropdownItem(ent.name, ()=>{
            this.selectedMediaPlayer = ent.entity_id;
            playerBtn.textContent = `${ent.name} ▼`;
            this.refs.playerDrop.root.classList.remove('open');
          });
          playerList.appendChild(item);
        });
      } else {
        const item = this._createDropdownItem(this.t.no_results, ()=>{});
        item.style.opacity = '0.7';
        playerList.appendChild(item);
      }
    }

    if (!this.configEntryId) {
      this._hass.callApi('GET','config/config_entries/entry')
        .then((entries)=>{ const e=entries.find((x)=>x.domain==='music_assistant'); this.configEntryId=e?e.entry_id:''; })
        .catch(()=>{ this.configEntryId=''; });
    }
  }
  get hass(){ return this._hass; }
  getCardSize(){ return 8; }

  // ====== Icons ======
  _logoDataURI(){ return 'data:image/svg+xml;base64,'+btoa(`<svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff9800"/><stop offset="1" stop-color="#ff5722"/></linearGradient></defs><rect x="4" y="4" width="56" height="56" rx="12" fill="url(#g)"/><path d="M40 12v26.5a8.5 8.5 0 1 1-3-6.5V20h-9v18.5a8.5 8.5 0 1 1-3-6.5V12h15z" fill="white"/></svg>`); }
  _fallbackAvatar(){ return 'data:image/svg+xml;base64,'+btoa(`<svg width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg"><rect width="44" height="44" rx="22" fill="#999"/><path d="M22 12a6 6 0 1 1 0 12a6 6 0 0 1 0-12zm0 14c6.6 0 12 3.4 12 7.5V36H10v-2.5C10 29.4 15.4 26 22 26z" fill="#fff"/></svg>`); }
  _ytmIcon(){ return 'data:image/svg+xml;base64,'+btoa(`<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#FF0033"/><polygon points="10,8 16,12 10,16" fill="#fff"/></svg>`); }
  _spotifyIcon(){ return 'data:image/svg+xml;base64,'+btoa(`<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#1DB954"/><path d="M7 10c3-1 7-1 10 1" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M7 13c2.6-.8 6-.7 8.5.6" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M7 16c2-.5 4.3-.4 6 .5" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`); }
  _libraryIcon(){ return 'data:image/svg+xml;base64,'+btoa(`<svg width="24" height="24" viewBox="0 0 24 24"><rect x="4" y="5" width="6" height="14" rx="1.5" fill="#666"/><rect x="10" y="5" width="6" height="14" rx="1.5" fill="#888"/><rect x="16" y="5" width="4" height="14" rx="1" fill="#aaa"/></svg>`); }
}

customElements.define('mass-search-card', MassSearchCard);
