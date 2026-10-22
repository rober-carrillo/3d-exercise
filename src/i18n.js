/**
 * Two languages, chosen rather than guessed at.
 *
 * Salpicón! is a Spanish word and most of the routes in it were recorded in
 * Colombia, so Spanish is where this starts; English is a button away. The
 * choice is remembered exactly the way the theme is, and for the same reason —
 * a visitor should have to say it once.
 *
 * There is no framework here and there is not going to be one. Static text
 * carries a `data-i18n` attribute naming its key, dynamic text asks `t()` for
 * a string, and `applyI18n()` walks the document whenever the language
 * changes. That is enough for a handful of pages, it adds nothing to the
 * download, and it keeps the English and the Spanish side by side in one file
 * where a missing translation is obvious.
 *
 *   <h2 data-i18n="hero.title"></h2>
 *   <button data-i18n="acct.signin" data-i18n-title="acct.signin.hint"></button>
 *   toast(t('rec.saved', { km: '4.12' }))
 */

const KEY = 'salpicon.lang.v1';
export const LANGS = ['es', 'en'];

const DICT = {
  es: {
    'lang.name': 'Español',
    'lang.other': 'English',
    'html.lang': 'es',

    'nav.signin': 'Entrar',
    'nav.account': 'Cuenta',
    'nav.yours': 'Tus rutas',
    'nav.library': 'Rutas públicas',
    'nav.record': 'Grabar',
    'nav.add': '＋ Añadir un GPX',
    'nav.home': '← Inicio',
    'nav.back': '← Volver',

    'hero.title': 'Comparte y revive tus rutas',
    'hero.lede': 'Graba una carrera, una salida en bici o una caminata — o trae una que ya tengas — y '
      + 'mírala de nuevo sobre el terreno real, al ritmo que de verdad llevaste. '
      + '¡Compártela con tus amigos y monta una salida el fin de semana!',
    'hero.signup': 'Crear una cuenta',
    'hero.havaccount': 'Ya tengo una',
    'hero.recordnew': 'Grabar algo nuevo',
    'hero.note.out': 'Entrar es lo que conserva tus rutas cuando este navegador las olvide.',
    'hero.note.in': 'Tus rutas quedan guardadas en tu cuenta, así que sobreviven a este navegador.',

    'stage.hint': 'Una ruta real, volando sola. Arrastra para mirar alrededor.',
    'stage.open': 'Abrir a pantalla completa →',
    'stage.nowebgl': '{name} — este navegador no tiene WebGL, así que la vista 3D no puede ejecutarse aquí.',
    'stage.savedata': '{name} — la vista 3D queda en espera mientras tu conexión esté en ahorro de datos.',
    'stage.none': 'Todavía no hay rutas publicadas.',

    'prev.heading': 'Tres para mirar',
    'prev.more': 'Ver la biblioteca pública de rutas →',

    'act.walk': 'Caminata', 'act.run': 'Carrera', 'act.ride': 'Bici', 'act.field': 'Deporte de cancha',
    'act.route': 'Ruta',

    'acct.title.in': 'Entrar',
    'acct.title.up': 'Crear una cuenta',
    'acct.title.me': 'Tu cuenta',
    'acct.why': 'Las rutas guardadas en este navegador desaparecen con él. Una cuenta las conserva, y te '
      + 'deja pasarle una a otra persona con un enlace.',
    'acct.email': 'Correo',
    'acct.pass': 'Contraseña',
    'acct.pass2': 'Repite la contraseña',
    'acct.mismatch': 'Las dos contraseñas no son iguales.',
    'acct.short': 'La contraseña necesita al menos seis caracteres.',
    'acct.forgot': '¿Olvidaste tu contraseña?',
    'acct.recover.title': 'Recuperar tu contraseña',
    'acct.recover.why': 'Escribe tu correo y te mandamos un enlace para poner una contraseña nueva.',
    'acct.recover.go': 'Mandar enlace',
    'acct.recover.sent': 'Si hay una cuenta con ese correo, el enlace ya va en camino. Revisa tu bandeja.',
    'acct.recover.sending': 'Mandando…',
    'acct.new.title': 'Pon una contraseña nueva',
    'acct.new.why': 'Entraste con el enlace del correo. Elige una contraseña y queda guardada.',
    'acct.new.go': 'Guardar contraseña',
    'acct.new.saving': 'Guardando…',
    'acct.new.done': 'Contraseña cambiada. Ya estás dentro.',
    'acct.go.in': 'Entrar',
    'acct.go.up': 'Crear cuenta',
    'acct.notnow': 'Ahora no',
    'acct.close': 'Cerrar',
    'acct.signedas': 'Has entrado como',
    'acct.upload': 'Subir las rutas de este navegador',
    'acct.signout': 'Salir',
    'acct.working.in': 'Entrando…',
    'acct.working.up': 'Creando tu cuenta…',
    'acct.done.in': 'Has entrado.',
    'acct.done.up': 'Cuenta creada — ya has entrado.',
    'acct.confirm': 'Cuenta creada. Busca el enlace de confirmación en tu correo y después entra.',
    'acct.welcome': '¡Correo confirmado! Ya has entrado.',
    'acct.linkbad': 'Ese enlace ya no sirve: {why} Pide uno nuevo creando la cuenta otra vez.',
    'acct.linkexpired': 'Ese enlace de confirmación ha caducado. Crea la cuenta otra vez para recibir uno nuevo.',
    'acct.signedout': 'Has salido. Las rutas de este navegador siguen aquí.',
    'acct.pending.one': '1 ruta de este navegador todavía no está en tu cuenta.',
    'acct.pending.many': '{n} rutas de este navegador todavía no están en tu cuenta.',
    'acct.pending.none': 'No hay nada en este navegador esperando a subirse.',
    'acct.nothing': 'No hay nada que subir.',
    'acct.uploading': 'Subiendo {i} de {n}…',
    'acct.uploaded': '{n} subidas. Las copias locales se conservan.',
    'acct.uploadfail': '{done} subidas, {failed} fallidas.',

    'err.badlogin': 'Ese correo y esa contraseña no coinciden con ninguna cuenta.',
    'err.exists': 'Ya hay una cuenta con ese correo. Prueba a entrar.',
    'err.password': 'La contraseña necesita al menos seis caracteres.',
    'err.email': 'Eso no parece una dirección de correo.',
    'err.rate': 'Demasiados intentos por ahora. Espera un minuto y vuelve a probar.',
    'err.confirm': 'Busca el enlace de confirmación en tu correo y después entra.',
    'err.offline': 'No hay conexión con el servidor.',
    'err.generic': 'Algo ha salido mal. Vuelve a probar.',

    'rec.recording': 'grabando',
    'rec.paused': 'en pausa',
    'rec.gps': 'esperando al GPS…',
    'rec.distance': 'Distancia',
    'rec.pace': 'Ritmo',
    'rec.points': 'Puntos',
    'rec.pause': 'Pausa',
    'rec.resume': 'Continuar',
    'rec.finish': 'Terminar',
    'rec.discard': 'Descartar',
    'rec.discard.confirm': 'Toca para confirmar',
    'rec.warn.title': 'Guardado en tu navegador hasta que crees una cuenta.',
    'rec.warn.body': 'Si borras los datos de navegación, cambias de aparato o usas otro navegador, '
      + 'podrías perder estas rutas.',
    'rec.warn.toast': 'Guardado en tu navegador hasta que crees una cuenta — podrías perder estas rutas.',
    'rec.count.sats': 'buscando satélites…',
    'rec.count.ready': 'GPS listo · ±{m} m',
    'rec.count.settling': 'todavía ajustando · ±{m} m',
    'rec.count.warn': 'Esta ruta se guardará en tu navegador hasta que crees una cuenta.',
    'rec.go': 'Ya',
    'rec.note.screen': 'Mantén esta pantalla abierta — las posiciones dejan de llegar cuando la app pasa a segundo plano.',
    'rec.note.bg': 'Grabando en segundo plano. Puedes bloquear la pantalla y guardar el teléfono.',
    'rec.note.bgshade': 'Grabando en segundo plano. Bloquea la pantalla y guarda el teléfono — la distancia '
      + 'y el tiempo siguen actualizándose en tus notificaciones.',
    'rec.note.blocked': 'La grabación funciona, pero las notificaciones están desactivadas para esta app, así que '
      + 'no se verá nada mientras la pantalla esté bloqueada.',
    'rec.note.turnon': 'Activarlas',
    'rec.note.awake': 'Manteniendo la pantalla encendida mientras grabas. Salir de la app detiene las posiciones, '
      + 'así que quédate en esta pantalla.',
    'rec.note.nowake': 'Este aparato no ha querido mantener la pantalla encendida. Si se apaga, la grabación para — '
      + 'échale un ojo de vez en cuando.',
    'rec.note.willstop': 'Si la pantalla se apaga o sales de la app, la grabación para. Instala la app de Android '
      + 'para grabar con la pantalla apagada.',
    'rec.denied': 'permiso de ubicación denegado',
    'rec.denied.help': 'Salpicón! necesita permiso de ubicación para grabar. Toca Descartar, permítelo en Ajustes y empieza de nuevo.',
    'rec.nopos': 'sin posición',
    'rec.nogps': 'Este aparato no puede informar de su posición',
    'rec.coarse': 'Le diste a Salpicón! ubicación aproximada, que viene del wifi y de las antenas y falla '
      + 'por cientos de metros. Para grabar una ruta hace falta la precisa.',
    'rec.coarse.fix': 'Abrir ajustes',
    'rec.warming': 'Buscando satélites… ya puedes darle a Grabar cuando quieras.',
    'loc.title': 'Salpicón! necesita tu ubicación precisa',
    'loc.why': 'Para dibujar tu ruta sobre el terreno hace falta la ubicación <b>precisa</b>, la del GPS. '
      + 'La <b>aproximada</b> viene del wifi y de las antenas, falla por cientos de metros y no sirve para '
      + 'grabar una ruta.',
    'loc.when': 'Solo se usa mientras grabas, y la ruta se queda en tu teléfono hasta que tú decidas subirla.',
    'loc.ask': 'Continuar',
    'loc.later': 'Ahora no',
    'loc.pick': 'En la siguiente pantalla elige <b>Precisa</b>.',
    'loc.coarse.title': 'Esa es la aproximada',
    'loc.coarse.why': 'Android te dio ubicación aproximada, que falla por cientos de metros. Para grabar '
      + 'rutas hay que cambiarla a precisa en los ajustes de la app.',
    'loc.open': 'Abrir ajustes',
    'loc.later.again': 'Sin ubicación no se pueden grabar rutas, pero todo lo demás funciona. Te lo volvemos '
      + 'a preguntar la próxima vez que abras la app.',
    'loc.later.last': 'Entendido, no te lo preguntamos más. Cuando quieras grabar una ruta puedes activar la '
      + 'ubicación desde los ajustes de la app.',
    'loc.denied': 'Sin ubicación no se pueden grabar rutas, pero todo lo demás funciona. Puedes activarla '
      + 'más tarde en los ajustes.',
    'loc.ok': 'Listo, ya puedes grabar rutas.',
    'rec.weak': 'señal débil · ±{m} m',
    'rec.still': ' · parado',
    'rec.nothing': 'No se ha grabado nada — ninguna posición utilizable.',
    'rec.saved.local': 'Guardado {name} — {km} km',
    'rec.saved.cloud': 'Guardado en tu cuenta — {km} km',
    'rec.saved.offline': 'Guardado en este aparato. Se subirá cuando vuelvas a tener conexión.',
    'sync.waiting': 'Sin conexión. {n} ruta(s) se subirán solas en cuanto vuelvas a tener internet.',
    'sync.uploading': 'Subiendo tus rutas… {done} de {total}',
    'sync.done.one': 'Tu ruta ya está en tu cuenta.',
    'sync.done.many': '{n} rutas subidas a tu cuenta.',
    'sync.failed': 'No se pudieron subir {n} ruta(s) todavía. Se intentará de nuevo solo.',
    'sync.pending': '{n} ruta(s) esperando a subirse a tu cuenta.',

    'routes.title': 'Tus rutas',
    'routes.empty.title': 'Todavía no hay nada aquí',
    'routes.empty.out': 'Graba una ruta o añade un archivo <code>.gpx</code> y aparecerá aquí. Las rutas guardadas '
      + 'en este navegador desaparecen con él — una cuenta es lo que hace que sobrevivan, y lo que te deja pasarle '
      + 'una a otra persona con un enlace.',
    'routes.empty.in': 'Graba una ruta o añade un archivo <code>.gpx</code> y aparecerá aquí. También puedes soltar '
      + 'un archivo en cualquier parte de esta página.',
    'routes.count.cloud': '{n} en tu cuenta',
    'routes.count.local': '{n} en este navegador',
    'routes.drop': 'Suelta archivos GPX para construirlos',
    'routes.total': 'Rutas',
    'routes.distance': 'Distancia',
    'routes.moving': 'Tiempo en movimiento',
    'routes.climbed': 'Desnivel positivo',
    'routes.best': 'Mejor a pie',
    'routes.best.none': 'todavía no hay nada cronometrado y lo bastante largo — cualquier cosa que grabes en la app contará',
    'routes.best.busy': 'comprobando {n} más…',
    'diag.none': 'No hay diagnóstico guardado. Graba una ruta y se guarda solo.',
    'diag.saved': 'Diagnóstico guardado: {n} posiciones, hasta {gap}s sin señal, precisión media ±{acc} m.',
    'diag.title': 'Diagnóstico de la última grabación',
    'del.title': '¿Borrar esta ruta?',
    'del.body': 'Vas a quitar <b>{name}</b> de este aparato. No se puede deshacer.',
    'del.body.only': 'Vas a quitar <b>{name}</b>. Esta ruta solo está aquí, así que no se puede recuperar.',
    'del.body.cloud': 'Vas a borrar <b>{name}</b> de tu cuenta, en todos tus aparatos. No se puede deshacer.',
    'del.working': 'Borrando…',
    'del.failed': 'No se pudo borrar: {why}',
    'del.yes': 'Borrar',
    'del.no': 'Cancelar',
    'del.done': 'Ruta borrada.',

    'lib.title': 'Rutas públicas',
    'lib.lede': 'Rutas publicadas con Salpicón!, abiertas para cualquiera. Ninguna es tuya — están aquí como ejemplo '
      + 'de lo que es una salida grabada una vez puesta sobre el terreno real. Abre cualquiera sin cuenta, o llévate '
      + 'la copia de un solo archivo y funciona sin conexión.',
    'lib.count': '{n} rutas públicas',
    'lib.none': 'Todavía no hay nada publicado aquí.',

    'row.pace': 'ritmo grabado',
    'row.local': 'este navegador',
    'row.local.app': 'solo en este teléfono',
    'row.example': 'ejemplo',
    'row.added': 'añadida',
    'row.copy': 'copiar enlace',
    'row.diag': 'diagnóstico',
    'row.gpx': 'gpx',
    'row.gpx.hint': 'Guardar esta ruta como archivo .gpx',
    'row.single': 'un solo archivo',
    'row.private': 'privada',
    'row.public': 'pública',
    'row.shared': 'compartida',
    'row.month.sum': '{n} rutas · {km} km · ↑ {up} m',
    'row.month.one': '1 ruta · {km} km · ↑ {up} m',

    'share.copied': 'Enlace copiado.',
    'share.opened': 'Enlace copiado. Cualquiera que lo tenga puede abrir esta ruta.',
    'share.blocked': 'No se ha podido copiar. El enlace es {url}',
    'share.local': 'Esta ruta solo está en este navegador, así que todavía no hay enlace. Entra y súbela primero.',
    'share.local.app': 'Esta ruta todavía está solo en este teléfono. Entra en tu cuenta y se subirá sola; '
      + 'entonces habrá un enlace.',
    'share.private': 'Esta ruta es privada. Ábrela primero y el enlace funcionará.',
    'share.gone': 'Esa ruta ya no está.',
    'share.nolink': 'No se ha podido crear un enlace para esa ruta.',
    'share.failed': 'No se ha podido hacer compartible esa ruta: {why}',
    'share.title': '¿Quién puede ver esta ruta?',
    'share.only': 'Solo yo',
    'share.only.why': 'Nadie más puede abrirla, ni con la dirección.',
    'share.link': 'Cualquiera con el enlace',
    'share.link.why': 'No aparecerá en ningún sitio público. Solo las personas a quienes mandes el enlace.',
    'share.pub': 'Pública',
    'share.pub.why': 'Cualquiera puede encontrarla y abrirla.',
    'share.label': 'Enlace',
    'share.copy': 'Copiar enlace',
    'share.replace': 'Reemplazar enlace',
    'share.replace.hint': 'Todos a quienes ya hayas mandado el enlace anterior perderán el acceso.',
    'share.done': 'Listo',
    'share.saving': 'Guardando…',
    'share.saved': 'Guardado.',
    'share.nowprivate': 'Privada. Cualquier enlace que mandaras antes ya no la abre.',
    'share.replacing': 'Reemplazando…',
    'share.replaced': 'Enlace nuevo listo. El anterior ha dejado de funcionar.',
    'share.viewer': 'Copiar enlace a esta ruta',
    'share.copying': 'Copiando…',

    'r.loading': 'Abriendo una ruta compartida…',
    'r.loading.why': 'Buscándola a partir del enlace que has seguido.',
    'r.incomplete': 'Ese enlace está incompleto',
    'r.incomplete.why': 'Le falta la parte que identifica la ruta. Pide el enlace otra vez.',
    'r.nodb': 'Aquí no hay rutas compartidas configuradas',
    'r.nodb.why': 'Esta copia de la app no tiene base de datos detrás, así que no puede abrir un enlace compartido.',
    'r.nothing': 'Ese enlace no abre nada',
    'r.nothing.why': 'Puede que lo haya retirado quien lo compartió, o que la dirección esté mal.',
    'r.failed': 'No se ha podido abrir esa ruta',
    'r.failed.offline': 'No hay conexión con el servidor. Vuelve a probar cuando tengas conexión.',
    'r.failed.why': 'Algo ha salido mal al buscarla. Prueba el enlace otra vez en un momento.',
    'r.open': 'Abrir Salpicón!',
    'map.offline': 'Estás sin conexión, así que no se pudo cargar la imagen de satélite. El relieve viene de '
      + 'los datos de elevación y de tu propia traza. Vuelve a abrir esta ruta con wifi o datos y se verá el mapa.',
    'map.partial': 'Solo llegó parte del mapa ({pct}%). Necesita conexión la primera vez que se abre una ruta.',
    'map.none': 'No se pudo cargar la imagen del mapa. Necesita conexión la primera vez que se abre una ruta.',
    'map.retry': 'Reintentar',
    'map.skip': 'Ver la ruta igual',

    'foot.all': 'Imágenes © Esri y sus colaboradores · Elevación de '
      + '<a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a> (SRTM, 3DEP y otros) · '
      + 'Mapa de reserva © <a href="https://www.openstreetmap.org/copyright">colaboradores de OpenStreetMap</a>',
    'foot.short': 'Imágenes © Esri y sus colaboradores · Elevación de '
      + '<a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a> (SRTM, 3DEP y otros)',
    'toast.noaccount': 'No se ha podido contactar con tu cuenta. Mostrando lo que hay en este aparato.',
    'toast.notgpx': 'Eso no es un archivo .gpx.',
    'toast.added.one': 'Añadida {name} — abriéndola…',
    'toast.added.many': 'Añadidas {n} rutas a este navegador.',
    'toast.gone': 'Esa ruta ya no está en este navegador.',
    'toast.savefail': 'No se ha podido guardar el archivo: {why}',
    'toast.saved': 'Guardado {name}',
    'toast.sendto': 'Elige a dónde mandarlo.',
  },

  en: {
    'lang.name': 'English',
    'lang.other': 'Español',
    'html.lang': 'en',

    'nav.signin': 'Sign in',
    'nav.account': 'Account',
    'nav.yours': 'Your routes',
    'nav.library': 'Public library',
    'nav.record': 'Record',
    'nav.add': '＋ Add a GPX',
    'nav.home': '← Home',
    'nav.back': '← Back',

    'hero.title': 'Share and replay your routes',
    'hero.lede': 'Record a run, a ride or a walk — or bring one you already have — and watch it played back '
      + 'across real terrain, at the pace you actually went. Share with your friends and start a weekend run!',
    'hero.signup': 'Create an account',
    'hero.havaccount': 'I already have one',
    'hero.recordnew': 'Record something new',
    'hero.note.out': 'Signing in is what keeps your routes when this browser forgets them.',
    'hero.note.in': 'Your routes are kept in your account, so they survive this browser.',

    'stage.hint': 'A real route, flying itself. Drag to look around.',
    'stage.open': 'Open it full screen →',
    'stage.nowebgl': '{name} — this browser has no WebGL, so the 3D replay cannot run here.',
    'stage.savedata': '{name} — the 3D replay is held back while your connection is set to save data.',
    'stage.none': 'No routes are published yet.',

    'prev.heading': 'Three to look at',
    'prev.more': 'See the public library of routes →',

    'act.walk': 'Walk', 'act.run': 'Run', 'act.ride': 'Ride', 'act.field': 'Field sport',
    'act.route': 'Route',

    'acct.title.in': 'Sign in',
    'acct.title.up': 'Create an account',
    'acct.title.me': 'Your account',
    'acct.why': 'Routes kept in this browser disappear with it. An account keeps them, and lets you hand '
      + 'one to somebody else with a link.',
    'acct.email': 'Email',
    'acct.pass': 'Password',
    'acct.pass2': 'Repeat the password',
    'acct.mismatch': 'Those two passwords are not the same.',
    'acct.short': 'Passwords need at least six characters.',
    'acct.forgot': 'Forgot your password?',
    'acct.recover.title': 'Recover your password',
    'acct.recover.why': 'Type your email and we will send a link for setting a new password.',
    'acct.recover.go': 'Send the link',
    'acct.recover.sent': 'If there is an account with that email, the link is on its way. Check your inbox.',
    'acct.recover.sending': 'Sending…',
    'acct.new.title': 'Set a new password',
    'acct.new.why': 'You came in from the link in your email. Choose a password and it is saved.',
    'acct.new.go': 'Save password',
    'acct.new.saving': 'Saving…',
    'acct.new.done': 'Password changed — you are signed in.',
    'acct.go.in': 'Sign in',
    'acct.go.up': 'Create account',
    'acct.notnow': 'Not now',
    'acct.close': 'Close',
    'acct.signedas': 'Signed in as',
    'acct.upload': "Upload this browser's routes",
    'acct.signout': 'Sign out',
    'acct.working.in': 'Signing in…',
    'acct.working.up': 'Creating your account…',
    'acct.done.in': 'Signed in.',
    'acct.done.up': 'Account created — you are signed in.',
    'acct.confirm': 'Account created. Check your email for a confirmation link, then sign in.',
    'acct.welcome': 'Email confirmed — you are signed in.',
    'acct.linkbad': 'That link no longer works: {why} Ask for a new one by creating the account again.',
    'acct.linkexpired': 'That confirmation link has expired. Create the account again to get a new one.',
    'acct.signedout': 'Signed out. Routes in this browser are still here.',
    'acct.pending.one': '1 route in this browser is not in your account yet.',
    'acct.pending.many': '{n} routes in this browser are not in your account yet.',
    'acct.pending.none': 'Nothing in this browser is waiting to be uploaded.',
    'acct.nothing': 'Nothing to upload.',
    'acct.uploading': 'Uploading {i} of {n}…',
    'acct.uploaded': '{n} uploaded. Local copies are kept.',
    'acct.uploadfail': '{done} uploaded, {failed} failed.',

    'err.badlogin': 'That email and password do not match an account.',
    'err.exists': 'There is already an account with that email. Try signing in.',
    'err.password': 'Passwords need at least six characters.',
    'err.email': 'That does not look like an email address.',
    'err.rate': 'Too many attempts just now. Wait a minute and try again.',
    'err.confirm': 'Check your email for a confirmation link, then sign in.',
    'err.offline': 'No connection to the server.',
    'err.generic': 'Something went wrong. Try again.',

    'rec.recording': 'recording',
    'rec.paused': 'paused',
    'rec.gps': 'waiting for GPS…',
    'rec.distance': 'Distance',
    'rec.pace': 'Pace',
    'rec.points': 'Points',
    'rec.pause': 'Pause',
    'rec.resume': 'Resume',
    'rec.finish': 'Finish',
    'rec.discard': 'Discard',
    'rec.discard.confirm': 'Tap to confirm',
    'rec.warn.title': 'Stored in your web browser until you make an account.',
    'rec.warn.body': 'Clear your browsing data, switch device or use a different browser and you could lose these routes.',
    'rec.warn.toast': 'Stored in your web browser until you make an account — you could lose these routes.',
    'rec.count.sats': 'finding satellites…',
    'rec.count.ready': 'GPS ready · ±{m} m',
    'rec.count.settling': 'still settling · ±{m} m',
    'rec.count.warn': 'This route will be stored in your web browser until you make an account.',
    'rec.go': 'Go',
    'rec.note.screen': 'Keep this screen open — position reporting stops when the app goes to the background.',
    'rec.note.bg': 'Recording in the background. You can lock the screen and put the phone away.',
    'rec.note.bgshade': 'Recording in the background. Lock the screen and put the phone away — distance and '
      + 'time keep updating in your notification shade.',
    'rec.note.blocked': 'Recording works, but notifications are off for this app, so nothing will show in your '
      + 'shade while the screen is locked.',
    'rec.note.turnon': 'Turn them on',
    'rec.note.awake': 'Keeping the screen on while recording. Leaving the app stops the fixes, so stay on this screen.',
    'rec.note.nowake': 'This device would not keep the screen on. If it sleeps, recording stops — check back now and then.',
    'rec.note.willstop': 'If the screen sleeps or you leave the app, recording stops. Install the Android app to '
      + 'record with the screen off.',
    'rec.denied': 'location permission denied',
    'rec.denied.help': 'Salpicón! needs location permission to record. Tap Discard, allow it in Settings, and start again.',
    'rec.nopos': 'no position',
    'rec.nogps': 'This device cannot report its position',
    'rec.coarse': 'Salpicón! was given approximate location, which comes from wifi and cell towers and is '
      + 'wrong by hundreds of metres. Recording a route needs the precise one.',
    'rec.coarse.fix': 'Open settings',
    'rec.warming': 'Finding satellites — you can press Record whenever you like.',
    'loc.title': 'Salpicón! needs your precise location',
    'loc.why': 'Drawing your route across the terrain needs <b>precise</b> location, the kind that comes '
      + 'from GPS. <b>Approximate</b> location comes from wifi and cell towers, is wrong by hundreds of '
      + 'metres, and cannot record a route.',
    'loc.when': 'It is only used while you are recording, and the route stays on your phone until you '
      + 'choose to upload it.',
    'loc.ask': 'Continue',
    'loc.later': 'Not now',
    'loc.pick': 'On the next screen, choose <b>Precise</b>.',
    'loc.coarse.title': 'That was the approximate one',
    'loc.coarse.why': 'Android granted approximate location, which is wrong by hundreds of metres. '
      + 'Recording routes needs it changed to precise in the app settings.',
    'loc.open': 'Open settings',
    'loc.later.again': 'Without location you cannot record routes, but everything else works. We will ask '
      + 'again next time you open the app.',
    'loc.later.last': 'Understood — we will not ask again. You can turn location on from the app settings '
      + 'whenever you want to record a route.',
    'loc.denied': 'Without location you cannot record routes, but everything else works. You can turn it '
      + 'on later in settings.',
    'loc.ok': 'All set — you can record routes now.',
    'rec.weak': 'weak signal · ±{m} m',
    'rec.still': ' · holding still',
    'rec.nothing': 'Nothing recorded — no usable position fixes.',
    'rec.saved.local': 'Saved {name} — {km} km',
    'rec.saved.cloud': 'Saved to your account — {km} km',
    'rec.saved.offline': 'Saved on this device. It will upload when you are back online.',
    'sync.waiting': 'No connection. {n} route(s) will upload on their own as soon as you are back online.',
    'sync.uploading': 'Uploading your routes… {done} of {total}',
    'sync.done.one': 'Your route is in your account now.',
    'sync.done.many': '{n} routes uploaded to your account.',
    'sync.failed': 'Could not upload {n} route(s) yet. It will keep trying on its own.',
    'sync.pending': '{n} route(s) waiting to upload to your account.',

    'routes.title': 'Your routes',
    'routes.empty.title': 'Nothing here yet',
    'routes.empty.out': 'Record a route or add a <code>.gpx</code> file and it will appear here. Routes kept in '
      + 'this browser disappear with it — an account is what makes them survive, and lets you hand one to somebody '
      + 'else with a link.',
    'routes.empty.in': 'Record a route or add a <code>.gpx</code> file and it will appear here. You can also drop '
      + 'a file anywhere on this page.',
    'routes.count.cloud': '{n} in your account',
    'routes.count.local': '{n} in this browser',
    'routes.drop': 'Drop GPX files to build them',
    'routes.total': 'Routes',
    'routes.distance': 'Distance',
    'routes.moving': 'Moving time',
    'routes.climbed': 'Climbed',
    'routes.best': 'Best on foot',
    'routes.best.none': 'nothing timed and long enough yet — anything you record in the app will count',
    'routes.best.busy': 'checking {n} more…',
    'diag.none': 'No diagnostic saved. Record a route and one is kept automatically.',
    'diag.saved': 'Diagnostic saved: {n} fixes, up to {gap}s with no signal, median accuracy ±{acc} m.',
    'diag.title': 'Diagnostic from the last recording',
    'del.title': 'Delete this route?',
    'del.body': 'This will remove <b>{name}</b> from this device. It cannot be undone.',
    'del.body.only': 'This will remove <b>{name}</b>. This route exists only here, so it cannot be recovered.',
    'del.body.cloud': 'This will delete <b>{name}</b> from your account, on every device. It cannot be undone.',
    'del.working': 'Deleting…',
    'del.failed': 'Could not delete it: {why}',
    'del.yes': 'Delete',
    'del.no': 'Cancel',
    'del.done': 'Route deleted.',

    'lib.title': 'Public library',
    'lib.lede': 'Routes published with Salpicón!, open to anyone. None of these are yours — they are here as '
      + 'examples of what a recorded outing looks like once it is draped over real terrain. Open any of them '
      + 'without an account, or take the single-file copy and it works offline.',
    'lib.count': '{n} public routes',
    'lib.none': 'Nothing is published here yet.',

    'row.pace': 'recorded pace',
    'row.local': 'this browser',
    'row.local.app': 'only on this phone',
    'row.example': 'example',
    'row.added': 'added',
    'row.copy': 'copy link',
    'row.diag': 'diagnostic',
    'row.gpx': 'gpx',
    'row.gpx.hint': 'Save this route as a .gpx file',
    'row.single': 'single file',
    'row.private': 'private',
    'row.public': 'public',
    'row.shared': 'shared',
    'row.month.sum': '{n} routes · {km} km · ↑ {up} m',
    'row.month.one': '1 route · {km} km · ↑ {up} m',

    'share.copied': 'Link copied.',
    'share.opened': 'Link copied. Anyone with it can now open this route.',
    'share.blocked': 'Copying was blocked. The link is {url}',
    'share.local': 'This route is only in this browser, so there is no link to it yet. Sign in and upload it first.',
    'share.local.app': 'This route is still only on this phone. Sign in and it will upload on its own, and '
      + 'then there will be a link.',
    'share.private': 'This route is private. Open it up first and the link will work.',
    'share.gone': 'That route is gone.',
    'share.nolink': 'No link could be made for that route.',
    'share.failed': 'Could not make that route shareable: {why}',
    'share.title': 'Who can see this route?',
    'share.only': 'Only me',
    'share.only.why': 'Nobody else can open it, even with the address.',
    'share.link': 'Anyone with the link',
    'share.link.why': 'It will not appear anywhere public. Only people you send the link to.',
    'share.pub': 'Public',
    'share.pub.why': 'Anyone can find and open it.',
    'share.label': 'Link',
    'share.copy': 'Copy link',
    'share.replace': 'Replace link',
    'share.replace.hint': 'Everyone you already sent the old link to will lose access.',
    'share.done': 'Done',
    'share.saving': 'Saving…',
    'share.saved': 'Saved.',
    'share.nowprivate': 'Private. Any link you sent before no longer opens it.',
    'share.replacing': 'Replacing…',
    'share.replaced': 'New link ready. The old one has stopped working.',
    'share.viewer': 'Copy link to this route',
    'share.copying': 'Copying…',

    'r.loading': 'Opening a shared route…',
    'r.loading.why': 'Fetching it from the link you followed.',
    'r.incomplete': 'That link is incomplete',
    'r.incomplete.why': 'It is missing the part that identifies the route. Ask for the link again.',
    'r.nodb': 'Shared routes are not set up here',
    'r.nodb.why': 'This copy of the app has no database behind it, so it cannot open a shared link.',
    'r.nothing': 'That link does not open anything',
    'r.nothing.why': 'It may have been withdrawn by the person who shared it, or the address may be wrong.',
    'r.failed': 'Could not open that route',
    'r.failed.offline': 'No connection to the server. Try again when you are back online.',
    'r.failed.why': 'Something went wrong fetching it. Try the link again in a moment.',
    'r.open': 'Open Salpicón!',
    'map.offline': 'You are offline, so the satellite imagery could not load. The relief comes from elevation '
      + 'data and from your own track. Open this route again on wifi or data and the map will be there.',
    'map.partial': 'Only part of the map arrived ({pct}%). It needs a connection the first time a route is opened.',
    'map.none': 'The map imagery did not load. It needs a connection the first time a route is opened.',
    'map.retry': 'Try again',
    'map.skip': 'Show the route anyway',

    'foot.all': 'Imagery © Esri and its contributors · Elevation from '
      + '<a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a> (SRTM, 3DEP and others) · '
      + 'Map fallback © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    'foot.short': 'Imagery © Esri and its contributors · Elevation from '
      + '<a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a> (SRTM, 3DEP and others)',
    'toast.noaccount': 'Could not reach your account. Showing what is on this device.',
    'toast.notgpx': 'That is not a .gpx file.',
    'toast.added.one': 'Added {name} — opening it…',
    'toast.added.many': 'Added {n} routes to this browser.',
    'toast.gone': 'That route is no longer in this browser.',
    'toast.savefail': 'Could not save the file: {why}',
    'toast.saved': 'Saved {name}',
    'toast.sendto': 'Choose where to send it.',
  },
};

const valid = l => (LANGS.includes(l) ? l : null);

function stored() {
  try { return valid(localStorage.getItem(KEY)); } catch { return null; }
}

/** What the browser is asking for, if it is one of ours. */
function preferred() {
  for (const tag of navigator.languages || [navigator.language || '']) {
    const base = valid(String(tag).slice(0, 2).toLowerCase());
    if (base) return base;
  }
  return null;
}

/**
 * The language is settled when this module loads, not when a page gets round
 * to asking for it.
 *
 * A remembered choice wins over everything; failing that the browser decides;
 * failing that it is Spanish — the app is called Salpicón! and most of what is
 * in it was recorded in Colombia, so Spanish is where somebody with no opinion
 * lands. Deciding here rather than inside `initLang()` means `t()` answers
 * correctly even somewhere that never calls it, such as a standalone
 * single-file route, which has the viewer in it and no page script of its own.
 */
let current = (() => {
  try { return stored() ?? 'es'; } catch { return 'es'; }
})();

/**
 * Apply that to the document, and remember an explicit choice.
 *
 * Spanish unless somebody has said otherwise — not whatever the browser is set
 * to. Salpicón! is a Spanish word, the routes in it were recorded in Colombia,
 * and the people it is for are more likely to have an English phone than to
 * want an English page. One press of the EN button settles it for good, which
 * is a smaller cost than the reverse. `preferred()` is still here and one line
 * away if that turns out to be the wrong call.
 */
export function initLang({ fallback = 'es' } = {}) {
  return apply(stored() ?? fallback, !!stored());
}

function apply(next, remember) {
  current = valid(next) ?? 'es';
  document.documentElement.lang = DICT[current]['html.lang'];
  if (remember) { try { localStorage.setItem(KEY, current); } catch {} }
  applyI18n();
  dispatchEvent(new CustomEvent('salpicon:lang', { detail: current }));
  return current;
}

export const lang = () => current;
export const setLang = next => apply(next, true);
export const toggleLang = () => setLang(current === 'es' ? 'en' : 'es');

/**
 * One string.
 *
 * A missing key returns the key itself rather than an empty space, because a
 * page with `hero.title` across the top is a bug anybody can see and report,
 * and a page with a blank heading looks like a layout problem.
 */
/**
 * Is this the Android app rather than a browser tab?
 *
 * It matters for wording and nothing else. "Kept in this browser" is accurate
 * — the app is a WebView and that is genuinely where the route is — and it is
 * also nonsense to somebody holding a phone who never opened a browser. Where
 * a string has an `.app` variant, the app gets it.
 */
const inApp = () => {
  try { return !!(window.Capacitor?.isNativePlatform?.() || window.Capacitor?.Plugins?.RelieveRecorder); }
  catch { return false; }
};

export function t(key, vars) {
  const dict = DICT[current] ?? DICT.es;
  if (inApp() && (dict[key + '.app'] ?? DICT.es[key + '.app'])) key += '.app';
  let s = DICT[current][key] ?? DICT.es[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

/**
 * Paint every marked element in the document.
 *
 * `data-i18n` sets the text, `data-i18n-html` sets markup (for the few strings
 * that carry a `<code>` or a link), and the attribute forms set a title, an
 * aria-label or a placeholder. Anything built by script asks `t()` instead and
 * is rebuilt by its own page when the language changes.
 */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
}

/**
 * Wire the switch.
 *
 * It shows the code of the language you would get by pressing it, not the one
 * you are in — the same rule the theme button follows, and the one that makes
 * a two-state button worth pressing rather than reading.
 */
export function langToggle(btn) {
  if (!btn) return;
  const paint = () => {
    const other = current === 'es' ? 'en' : 'es';
    btn.textContent = other.toUpperCase();
    btn.title = `${t('lang.other')} — switch language`;
    btn.setAttribute('aria-label', btn.title);
  };
  btn.addEventListener('click', () => { toggleLang(); paint(); });
  addEventListener('salpicon:lang', paint);
  paint();
  return paint;
}
