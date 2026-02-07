// StreamHub Lampa plugin (minimal)
// Inserts "Online" button; fetches streams from adapter backend and plays via Lampa.Player
(function(){
  const script = document.currentScript || Array.from(document.scripts).pop();
  const BASE = (script && script.src) ? script.src.replace(/\/plugin\.js.*/, '') : '';
  const API_STREAMS = BASE + '/streams';
  const BUTTON_VERSION = 'v0.1';

  function translateInit(){
    if(!Lampa.Lang){
      let lang_data = {};
      Lampa.Lang = {
        add:(d)=>{lang_data=d;},
        translate:(k)=> lang_data[k]?lang_data[k].ru:k,
      };
    }
    Lampa.Lang.add({
      title_online:{ru:'Онлайн',en:'Online'},
      online_waitlink:{ru:'Получаем ссылки...',en:'Fetching links...'},
      online_nolink:{ru:'Нет ссылок',en:'No links'},
    });
  }

  function addButton(){
    const btn = $(Lampa.Lang.translate(`<div class="full-start__button selector view--online" data-subtitle="${BUTTON_VERSION}">
      <svg width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M19.98 14.44l-6.24-4.54a.76.76 0 00-1.2.61v9.07c0 .28.16.54.41.67.11.05.23.08.34.08.15 0 .31-.05.44-.14l6.24-4.53a.74.74 0 00.31-.61c0-.24-.12-.47-.3-.61z"/><path fill="currentColor" d="M15.03 0C6.73 0 0 6.73 0 15.03S6.73 30.05 15.03 30.05c8.3 0 15.02-6.73 15.02-15.02C30.05 6.73 23.32 0 15.03 0zm0 27.54c-6.91 0-12.52-5.6-12.52-12.51 0-6.91 5.61-12.52 12.52-12.52 6.91 0 12.51 5.61 12.51 12.52 0 6.91-5.6 12.51-12.51 12.51z"/></svg>
      <span>#{title_online}</span>
    </div>`));

    btn.on('hover:enter',()=>{
      Lampa.Activity.push({
        url: '',
        title: Lampa.Lang.translate('title_online'),
        component: 'streamhub_online',
        search: Lampa.Activity.active().data.movie.title,
        movie: Lampa.Activity.active().data.movie,
        page: 1
      });
    });

    Lampa.Listener.follow('full',(e)=>{
      if(e.type === 'complite'){
        e.object.activity.render().find('.view--torrent').after(btn);
      }
    });
  }

  function registerComponent(){
    if(Lampa.Component.get('streamhub_online')) return;

    function Online(){
      this.create = ()=>{
        this.activity.loader(true);
        const movie = this.activity.data.movie || {};
        const imdb = movie.imdb_id || movie.imdbId || movie.imdb || '';
        const season = movie.season || movie.number_of_season;
        const episode = movie.episode || movie.number_of_episode;
        const params = new URLSearchParams();
        if(imdb) params.set('imdb', imdb);
        if(season) params.set('season', season);
        if(episode) params.set('episode', episode);

        fetch(`${API_STREAMS}?${params.toString()}`)
          .then(r=>r.json())
          .then(({streams=[]})=>{
            build(streams);
          })
          .catch(()=>{
            this.empty();
          })
          .finally(()=>{
            this.activity.loader(false);
          });
      };

      const build = (streams)=>{
        if(!streams.length){
          this.empty();
          return;
        }

        const scroll = new Lampa.Scroll({mask:true});
        const body = $('<div class="online">"></div>');
        scroll.append(body);

        streams.forEach((s)=>{
          const card = Lampa.Template.get('online',{
            title: s.title || s.quality || s.source || 'Link',
            quality: s.quality ? s.quality + ' ' : '',
            info: s.source ? '(' + s.source + ')' : ''
          });
          card.on('hover:enter',()=>{
            Lampa.Player.play({
              title: s.title || movie.title,
              url: s.url,
              quality: s.quality,
              subtitles: s.subtitles || []
            });
            Lampa.Player.playlist([{title:s.title||'Stream',url:s.url}]);
          });
          body.append(card);
        });

        this.activity.render().find('.activity__body').empty().append(scroll.render());
        Lampa.Controller.add('streamhub_online',{
          type:'buttons',
          toggle:()=>{
            Lampa.Controller.collectionSet(scroll.render());
            Lampa.Controller.collectionFocus(scroll.render().find('.selector').first(),scroll.render());
          },
          back:()=>{
            Lampa.Activity.backward();
          }
        });
        Lampa.Controller.toggle('streamhub_online');
      };

      this.start = ()=>{};
      this.pause = ()=>{};
      this.stop = ()=>{};
      this.render = ()=>{
        return $('<div class="activity__body">'+Lampa.Lang.translate('online_waitlink')+'</div>');
      };
      this.empty = ()=>{
        this.activity.render().find('.activity__body').html('<div class="empty">'+Lampa.Lang.translate('online_nolink')+'</div>');
      };
    }

    Lampa.Component.add('streamhub_online', Online);
  }

  function boot(){
    translateInit();
    resetTemplates();
    registerComponent();
    addButton();
  }

  boot();
})();
