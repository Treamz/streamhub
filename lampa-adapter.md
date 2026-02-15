# Lampa Adapter

Адаптер для Lampa отдает два JS-плагина и проксирует Core `/query` в удобный `/streams`.

## Эндпоинты
- `GET /plugin.js` — базовый плагин (кнопка для StremHub каталога, без онлайн режима).
- `GET /online_mod.js` — упрощённый онлайн-плагин (StreamHub style) с поддержкой фильмов и сериалов.
- `GET /streams?imdb=&query=&season=&episode=` — прокси к Core (`POST /query`), возвращает `{ streams: [...] }`.
- `GET /health` — проверка живости.

## online_mod.js (текущая версия)
- Одна кнопка «Онлайн» (`.view--online_streamhub`) вставляется на экран карточки; подпись — "StreamHub".
- Фильм: сразу показывает список стримов (сейчас mock: два потока 1080p/720p). Сериал: список сезонов → список серий → список стримов выбранной серии. В списке стримов есть «← Назад» к сериям.
- Проигрывание: Enter по стриму → `Lampa.Player.play` и плейлист из одного элемента.
- Шаблоны/CSS минимальные, загружаются на старте.
- Балансеры, RCH, таймлайны, история просмотров, голоса — убраны.
- `Activity.active().method === 'tv'` поддерживается: для сериалов берёт `active.card` при запуске.
- Стримы пока mock; чтобы подключить Core, заменить блок mock в `loadStreams` на `fetchStreams(payload)` (уже есть функция).

## Конфигурация/сборка
- Исходник: `adapters/lampa-adapter/static/online_mod.js`.
- Сборка адаптера: `cd adapters/lampa-adapter && npm run build` (tsc).
- Отдаётся из `src/index.ts`, CORS включен (origin `*`).

## Быстрый запуск (dev)
```bash
# корень репо
npm install
npm run build --workspaces # или отдельный build в adapters/lampa-adapter
# запустить через docker-compose.dev.yml
```

## Замечания
- Для реальной интеграции уберите mock и обеспечьте доступ Core по `CORE_URL` (по умолчанию `http://core:8080`).
- Если нужно вернуть расширенную wtch-логику (балансеры/RCH) — придётся взять старый плагин и адаптировать под StreamHub.
