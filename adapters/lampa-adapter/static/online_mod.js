// StreamHub "online_mod" compatible plugin for Lampa
// Drops in place of nb557 online_mod but uses StreamHub adapter backend.
(function () {
  const script = document.currentScript || Array.from(document.scripts).pop();
  const BASE = script && script.src ? script.src.replace(/\/online_mod\.js.*/, '') : '';
  const API_STREAMS = BASE + '/streams';
  const COMPONENT = 'online_mod_streamhub';

  function t(key) {
    const dict = {
      ru: {
        title: 'Онлайн',
        wait: 'Получаем ссылки...',
        empty: 'Нет ссылок',
        src: 'StreamHub',
      },
      en: {
        title: 'Online',
        wait: 'Fetching links...',
        empty: 'No links',
        src: 'StreamHub',
      },
    };
    const lang = (Lampa.Storage && Lampa.Storage.field && Lampa.Storage.field('language')) || 'ru';
    return (dict[lang] && dict[lang][key]) || dict.ru[key];
  }

  function addButton() {
    const btn = $(
      `<div class="full-start__button selector view--online">
        <svg width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M19.98 14.44l-6.24-4.54a.76.76 0 00-1.2.61v9.07c0 .28.16.54.41.67.11.05.23.08.34.08.15 0 .31-.05.44-.14l6.24-4.53a.74.74 0 00.31-.61c0-.24-.12-.47-.3-.61z"/><path fill="currentColor" d="M15.03 0C6.73 0 0 6.73 0 15.03S6.73 30.05 15.03 30.05c8.3 0 15.02-6.73 15.02-15.02C30.05 6.73 23.32 0 15.03 0zm0 27.54c-6.91 0-12.52-5.6-12.52-12.51 0-6.91 5.61-12.52 12.52-12.52 6.91 0 12.51 5.61 12.51 12.52 0 6.91-5.6 12.51-12.51 12.51z"/></svg>
        <span>${t('title')}</span>
      </div>`
    );

    btn.on('hover:enter', () => {
      const active = Lampa.Activity.active();
      Lampa.Activity.push({
        url: '',
        title: t('title'),
        component: COMPONENT,
        search: active?.data?.movie?.title,
        movie: active?.data?.movie,
        page: 1,
      });
    });

    Lampa.Listener.follow('full', (e) => {
      if (e.type === 'complite') {
        const holder = e.object.activity.render().find('.view--torrent');
        if (holder.length) holder.after(btn);
      }
    });
  }

  function registerComponent() {
    if (Lampa.Component.get(COMPONENT)) return;

    function Online() {
      const cache = {};

      const fetchStreams = (movie) => {
        const imdb = movie.imdb_id || movie.imdbId || movie.imdb || '';
        const season = movie.season || movie.number_of_season;
        const episode = movie.episode || movie.number_of_episode;
        const key = `${imdb}-${season || ''}-${episode || ''}`;
        if (cache[key]) return Promise.resolve(cache[key]);

        const params = new URLSearchParams();
        if (imdb) params.set('imdb', imdb);
        if (season) params.set('season', season);
        if (episode) params.set('episode', episode);

        return fetch(`${API_STREAMS}?${params.toString()}`)
          .then((r) => r.json())
          .then((data) => {
            cache[key] = data.streams || [];
            return cache[key];
          });
      };

      const renderList = (streams, movie) => {
        if (!streams.length) return this.empty();

        const scroll = new Lampa.Scroll({ mask: true });
        const body = $('<div class="online"></div>');
        scroll.append(body);

        streams.forEach((s) => {
          const card = Lampa.Template.get('online', {
            title: s.title || s.quality || s.source || t('src'),
            quality: s.quality ? s.quality + ' ' : '',
            info: s.source ? '(' + s.source + ')' : '',
          });
          card.on('hover:enter', () => {
            Lampa.Player.play({
              title: s.title || movie.title,
              url: s.url,
              quality: s.quality,
              subtitles: s.subtitles || [],
            });
            Lampa.Player.playlist([{ title: s.title || 'Stream', url: s.url }]);
          });
          body.append(card);
        });

        this.activity.render().find('.activity__body').empty().append(scroll.render());
        Lampa.Controller.add(COMPONENT, {
          type: 'buttons',
          toggle: () => {
            Lampa.Controller.collectionSet(scroll.render());
            Lampa.Controller.collectionFocus(scroll.render().find('.selector').first(), scroll.render());
          },
          back: () => Lampa.Activity.backward(),
        });
        Lampa.Controller.toggle(COMPONENT);
      };

      this.create = () => {
        this.activity.loader(true);
        const movie = this.activity.data.movie || {};

        fetchStreams(movie)
          .then((streams) => renderList(streams, movie))
          .catch(() => this.empty())
          .finally(() => this.activity.loader(false));
      };

      this.start = () => {};
      this.pause = () => {};
      this.stop = () => {};
      this.render = () => $('<div class="activity__body">' + t('wait') + '</div>');
      this.empty = () => {
        this.activity.render().find('.activity__body').html('<div class="empty">' + t('empty') + '</div>');
      };
    }

    Lampa.Component.add(COMPONENT, Online);
  }

  function boot() {
    registerComponent();
    addButton();
  }

  boot();
})();
