// StreamHub simplified plugin: movie/tv, seasons & episodes, no balance
(function () {
  'use strict'

  const COMPONENT = 'streamhub_online'
  const BTN_CLASS = 'view--online_streamhub'
  const ORIGIN = (document.currentScript || Array.from(document.scripts).pop()).src.replace(/\/online_mod\.js.*/, '')

  const strings = {
    title_online: { ru: 'Онлайн', en: 'Online', uk: 'Онлайн' },
    lampac_watch: { ru: 'Смотреть онлайн', en: 'Watch online', uk: 'Дивитися онлайн' },
    empty_title_two: { ru: 'Нет результатов', en: 'No results', uk: 'Немає результатів' },
    empty_text: { ru: 'Потоки не найдены', en: 'Streams not found', uk: 'Потоки не знайдені' },
    season: { ru: 'Сезон', en: 'Season', uk: 'Сезон' },
    episode: { ru: 'Серия', en: 'Episode', uk: 'Епізод' },
    quality: { ru: 'Качество', en: 'Quality', uk: 'Якість' },
    source: { ru: 'Источник', en: 'Source', uk: 'Джерело' },
    back: { ru: 'Назад', en: 'Back', uk: 'Назад' },
    helper_online_file: { ru: 'Удерживайте "ОК" для меню', en: 'Hold OK for menu', uk: 'Утримуйте "ОК" для меню' },
  }

  function t(key) {
    const l = (Lampa.Storage.field && Lampa.Storage.field('language')) || 'ru'
    return (strings[key] && (strings[key][l] || strings[key].ru)) || key
  }

  function ensureTemplates() {
    Lampa.Template.add('wtch_simple_item', `
      <div class="online-item selector">
        <div class="online-item__title">{title}</div>
        <div class="online-item__meta">{meta}</div>
      </div>`)
    Lampa.Template.add('wtch_empty', `
      <div class="online-empty">
        <div class="online-empty__title">${t('empty_title_two')}</div>
        <div class="online-empty__time">${t('empty_text')}</div>
      </div>`)
    Lampa.Template.add('wtch_css', `
      <style>
      .online-item{padding:1em;background:rgba(255,255,255,0.08);border-radius:.35em;margin-bottom:.7em;line-height:1.4}
      .online-item__title{font-size:1.2em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .online-item__meta{opacity:.7;font-size:.95em;margin-top:.2em}
      .online-empty{padding:1em 0}
      .online-empty__title{font-size:1.3em;margin-bottom:.2em}
      .online-empty__time{opacity:.7}
      .view--online_wtch svg{margin-right:.25em}
      </style>`)
    $('body').append(Lampa.Template.get('wtch_css', {}, true))
  }

  function fetchStreams(payload) {
    const qs = new URLSearchParams()
    if (payload.imdb) qs.set('imdb', payload.imdb)
    if (payload.query) qs.set('query', payload.query)
    if (payload.season) qs.set('season', payload.season)
    if (payload.episode) qs.set('episode', payload.episode)
    return fetch(ORIGIN + '/streams?' + qs.toString())
      .then((r) => r.json())
      .then((d) => d.streams || [])
      .catch(() => [])
  }

  function Component(object) {
    const scroll = new Lampa.Scroll({ mask: true })
    const files = new Lampa.Explorer(object)
    let last

    this.create = () => files.render()
    this.render = () => files.render()

    this.start = () => {
      ensureTemplates()
      this.loading(true)
      const movie = object.movie || {}
      const isTv = (movie.name || movie.number_of_seasons) ? true : false
      if (!isTv) {
        loadStreams({ movie })
      } else {
        showSeasons(movie)
      }
    }

    const loadStreams = ({ movie, season, episode, titleOverride }) => {
      // MOCK: заменить на fetchStreams(payload)
      const payload = {
        imdb: movie.imdb_id || movie.imdb,
        query: movie.title || movie.name || titleOverride,
        season,
        episode,
      }
      // Заглушка: имитируем ответ
      const mock = [
        { title: `${titleOverride || payload.query} • ${season ? 'S'+season : ''}${episode ? 'E'+episode : ''} 1080p`, quality: '1080p', source: 'Mock', url: 'https://example.com/stream1.m3u8' },
        { title: `${titleOverride || payload.query} • ${season ? 'S'+season : ''}${episode ? 'E'+episode : ''} 720p`, quality: '720p', source: 'Mock', url: 'https://example.com/stream2.m3u8' }
      ]
      setTimeout(() => {
        this.loading(false)
        drawStreams(mock, movie, season)
      }, 300)
    }

    const showSeasons = (movie) => {
      this.loading(false)
      scroll.clear()
      const seasons = movie.seasons || []
      if (!seasons.length && movie.id) {
        // fetch seasons list
        const tmdbId = movie.id
        Lampa.Api.sources.tmdb.get('tv/' + tmdbId, {}, (data) => {
          movie.seasons = data.seasons || []
          renderSeasonList(movie)
        }, () => renderSeasonList(movie))
      } else {
        renderSeasonList(movie)
      }
    }

    const renderSeasonList = (movie) => {
      scroll.clear()
      const list = (movie.seasons || []).filter((s) => s.season_number >= 1)
      if (!list.length) return this.empty()
      list.forEach((s) => {
        const meta = `${t('season')} ${s.season_number} · ${s.episode_count || ''}`
        const card = Lampa.Template.get('wtch_simple_item', {
          title: s.name || meta,
          meta,
        })
        card.on('hover:enter', () => loadEpisodes(movie, s.season_number))
        card.on('hover:focus', (e) => { last = e.target; scroll.update($(e.target), true) })
        scroll.append(card)
      })
      finalizeNav()
    }

    const loadEpisodes = (movie, seasonNumber) => {
      this.loading(true)
      const tmdbId = movie.id
      Lampa.Api.sources.tmdb.get('tv/' + tmdbId + '/season/' + seasonNumber, {}, (data) => {
        this.loading(false)
        const episodes = data.episodes || []
        scroll.clear()
        // Добавляем кнопку назад к сезонам
        const back = $('<div class="online-item selector"><div class="online-item__title">← ' + t('back') + '</div></div>')
        back.on('hover:enter', () => renderSeasonList(movie))
        back.on('hover:focus', (e) => { last = e.target; scroll.update($(e.target), true) })
        scroll.append(back)

        episodes.forEach((ep) => {
          const meta = `${t('season')} ${seasonNumber} · ${t('episode')} ${ep.episode_number}`
          const title = ep.name || meta
          const card = Lampa.Template.get('wtch_simple_item', { title, meta })
          card.on('hover:enter', () => loadStreams({ movie, season: seasonNumber, episode: ep.episode_number, titleOverride: title }))
          card.on('hover:focus', (e) => { last = e.target; scroll.update($(e.target), true) })
          scroll.append(card)
        })
        finalizeNav()
      }, () => { this.loading(false); this.empty() })
    }

    const drawStreams = (streams, movie, seasonNumber) => {
      scroll.clear()
      // back button to episodes or seasons
      const back = $('<div class="online-item selector"><div class="online-item__title">← ' + t('back') + '</div></div>')
      back.on('hover:enter', () => {
        if (seasonNumber) loadEpisodes(movie, seasonNumber)
        else if (movie.seasons && movie.seasons.length) renderSeasonList(movie)
        else this.empty()
      })
      back.on('hover:focus', (e) => { last = e.target; scroll.update($(e.target), true) })
      scroll.append(back)

      streams.forEach((s) => {
        const metaParts = []
        if (s.quality) metaParts.push(t('quality') + ': ' + s.quality)
        if (s.source) metaParts.push(t('source') + ': ' + s.source)
        const meta = metaParts.join(' · ')
        const card = Lampa.Template.get('wtch_simple_item', {
          title: s.title || movie.title || movie.name || 'Stream',
          meta,
        })
        card.on('hover:enter', () => {
          Lampa.Player.play({
            title: s.title || movie.title || movie.name || 'Stream',
            url: s.url,
            quality: s.quality,
            subtitles: s.subtitles || []
          })
          Lampa.Player.playlist([{ title: s.title || 'Stream', url: s.url }])
        })
        card.on('hover:focus', (e) => { last = e.target; scroll.update($(e.target), true) })
        scroll.append(card)
      })
      finalizeNav()
    }

    const finalizeNav = () => {
      files.appendFiles(scroll.render())
      Lampa.Controller.add(COMPONENT, {
        toggle: () => {
          Lampa.Controller.collectionSet(scroll.render(), files.render())
          Lampa.Controller.collectionFocus(last || scroll.render().find('.selector').first(), scroll.render())
        },
        back: () => Lampa.Activity.backward()
      })
      Lampa.Controller.toggle(COMPONENT)
    }

    this.empty = () => {
      scroll.clear()
      scroll.append(Lampa.Template.get('wtch_empty', {}))
      finalizeNav()
    }

    this.loading = (state) => { this.activity.loader(!!state) }
    this.pause = () => {}
    this.stop = () => {}
    this.destroy = () => { scroll.destroy(); files.destroy() }
  }

  function injectButton(activity) {
    if (!activity || !activity.render) return
    const render = activity.render()
    if (!render.length || render.find('.' + BTN_CLASS).length) return

    const btn = $(
      `<div class="full-start__button selector ${BTN_CLASS}" data-subtitle="StreamHub">
         <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
         <span>#{title_online}</span>
       </div>`
    )

    btn.on('hover:enter', () => {
      ensureTemplates()
      Lampa.Component.add(COMPONENT, Component)
      const active = Lampa.Activity.active()
      const card = (active && active.method === 'tv') ? (active.card || {}) : (activity.data.movie || activity.card || {})
      Lampa.Activity.push({
        url: '',
        title: t('title_online'),
        component: COMPONENT,
        search: card.title || card.name || '',
        movie: card,
        page: 1
      })
    })

    render.find('.button--play').before(btn)
  }

  function startPlugin() {
    if (window.streamhub_online_plugin) return
    window.streamhub_online_plugin = true

    ensureTemplates()
    Lampa.Lang.add(strings)
    Lampa.Component.add(COMPONENT, Component)

    Lampa.Listener.follow('full', function (e) {
      if (e.type === 'complite') {
        injectButton(e.object.activity)
      }
    })
  }

  if (Lampa.Manifest && Lampa.Manifest.app_digital >= 155) startPlugin()
})()
