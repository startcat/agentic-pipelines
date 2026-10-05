import { describe, expect, test } from 'bun:test';
import {
  buildPlistSpec,
  computePath,
  cronToCalendarIntervals,
  foreignJobsMentioning,
  jobsNamedAfter,
  labelFor,
  logPathFor,
  parseDisabledLabels,
  renderPlist,
  stripGeneratedAt,
  unresolvedInPath,
} from '../../src/install/launchd.ts';

describe('cronToCalendarIntervals', () => {
  test('una hora fija omite los campos con asterisco', () => {
    expect(cronToCalendarIntervals('0 3 * * *')).toEqual([{ Minute: 0, Hour: 3 }]);
  });

  test('una lista expande a un horario por valor', () => {
    expect(cronToCalendarIntervals('0 3,15 * * *')).toEqual([
      { Minute: 0, Hour: 3 },
      { Minute: 0, Hour: 15 },
    ]);
  });

  test('listas en dos campos expanden al producto de ambas', () => {
    expect(cronToCalendarIntervals('0,30 3 * * *')).toEqual([
      { Minute: 0, Hour: 3 },
      { Minute: 30, Hour: 3 },
    ]);
  });

  test('el domingo 7 de cron se normaliza al 0 de launchd', () => {
    expect(cronToCalendarIntervals('0 3 * * 7')).toEqual([{ Minute: 0, Hour: 3, Weekday: 0 }]);
  });

  test('cinco asteriscos es "cada minuto": ningún campo, un solo horario', () => {
    expect(cronToCalendarIntervals('* * * * *')).toEqual([{}]);
  });

  // El error tiene que decir la alternativa, no solo que no se puede: es la
  // diferencia entre que el operador escriba una lista y que se vaya a
  // escribir el plist a mano, que es lo que este comando existe para evitar.
  test('un paso se rechaza nombrando la alternativa', () => {
    expect(() => cronToCalendarIntervals('*/15 * * * *')).toThrow(/lista separada por comas/);
  });

  test('un rango se rechaza nombrando la alternativa', () => {
    expect(() => cronToCalendarIntervals('0 9-17 * * *')).toThrow(/lista separada por comas/);
  });

  test('un número de campos distinto de 5 se rechaza diciendo cuántos hay', () => {
    expect(() => cronToCalendarIntervals('0 3 * *')).toThrow(/5 campos/);
  });

  test('un valor fuera de rango se rechaza nombrando el campo', () => {
    expect(() => cronToCalendarIntervals('0 25 * * *')).toThrow(/Hour/);
  });

  test('una expansión mayor que el tope se rechaza', () => {
    expect(() => cronToCalendarIntervals('0,1,2,3,4,5 0,1,2,3,4 * * *')).toThrow(/24/);
  });
});

describe('labelFor', () => {
  test('la etiqueta es determinista a partir del nombre del pipeline', () => {
    expect(labelFor('docs-review')).toBe('cat.start.pipelines.docs-review');
  });
});

describe('computePath', () => {
  const which = (name: string): string | null =>
    ({
      git: '/usr/bin/git',
      jq: '/opt/homebrew/bin/jq',
      yarn: '/Users/x/.nvm/versions/node/v22/bin/yarn',
    })[name] ?? null;

  test('incluye el directorio de cada binario declarado', () => {
    const path = computePath(['git', 'jq'], which);
    expect(path.split(':')).toEqual(['/usr/bin', '/opt/homebrew/bin', '/bin', '/usr/sbin', '/sbin']);
  });

  test('los directorios extra van primero y no se duplican', () => {
    const path = computePath(['git'], which, ['/Users/x/.bun/bin', '/usr/bin']);
    expect(path.split(':')).toEqual(['/Users/x/.bun/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  });

  // El incidente del 2026-08-29: el plist escrito a mano no llevaba el
  // directorio de uno de los binarios declarados. Calcularlo lo hace imposible.
  test('un binario que no resuelve falla nombrándolo, en vez de generar un PATH incompleto', () => {
    expect(() => computePath(['git', 'inexistente'], which)).toThrow(/inexistente/);
  });

  // Un PATH calculado solo desde
  // `requires.bin` puede no incluir `/bin`, y en macOS `sh` SOLO vive ahí.
  // `runner/shell.ts` y `guards/evaluate.ts` lanzan `sh -c` con este PATH
  // para cualquier paso `shell` o guarda `shell:`: sin `/bin`, el job
  // instalado moriría en el primer paso ("Executable not found in $PATH: sh",
  // verificado en vivo).
  test('el PATH generado siempre incluye el suelo de directorios de sistema, con /bin', () => {
    const path = computePath(['git'], which);
    expect(path.split(':')).toContain('/bin');
    expect(path.split(':')).toContain('/usr/bin');
    expect(path.split(':')).toContain('/usr/sbin');
    expect(path.split(':')).toContain('/sbin');
  });

  test('el suelo de sistema no se duplica si un binario ya vive en uno de esos directorios', () => {
    // "git" resuelve a /usr/bin/git, que ya es parte del suelo.
    const path = computePath(['git'], which);
    expect(path.split(':').filter((dir) => dir === '/usr/bin')).toHaveLength(1);
  });
});

describe('unresolvedInPath', () => {
  // Reproduce el incidente: un PATH que no incluye /bin no puede resolver
  // "sh", aunque todos los `requires.bin` declarados sí resuelvan.
  test('detecta que "sh" no resuelve si el PATH no lleva /bin', () => {
    const which = (name: string, path?: string): string | null => {
      if (path !== '/usr/bin:/opt/homebrew/bin') return null;
      return name === 'git' ? '/usr/bin/git' : null;
    };
    expect(unresolvedInPath('/usr/bin:/opt/homebrew/bin', ['git'], which)).toEqual(['sh']);
  });

  // Con el suelo de sistema puesto (el arreglo de computePath), "sh" resuelve
  // también, así que el cinturón no encuentra nada que objetar.
  test('con el PATH ya calculado (con el suelo puesto) todo resuelve, incluido "sh"', () => {
    const which = (name: string, path?: string): string | null => {
      if (path !== '/usr/bin:/opt/homebrew/bin:/bin') return null;
      return { git: '/usr/bin/git', sh: '/bin/sh' }[name] ?? null;
    };
    expect(unresolvedInPath('/usr/bin:/opt/homebrew/bin:/bin', ['git'], which)).toEqual([]);
  });

  test('nombra también un binario declarado que no resuelve, no solo "sh"', () => {
    const which = (name: string): string | null => (name === 'sh' ? '/bin/sh' : null);
    expect(unresolvedInPath('/bin', ['inexistente'], which)).toEqual(['inexistente']);
  });

  // Cinturón, no solo suelo: comprueba contra el PATH que se le pasa, NUNCA
  // contra el que tendría el proceso que llama — de ahí que `which` reciba
  // el PATH como segundo argumento en vez de mirar `process.env.PATH`.
  test('pasa el PATH calculado a la función which, no el del proceso llamante', () => {
    const seen: (string | undefined)[] = [];
    const which = (name: string, path?: string): string | null => {
      seen.push(path);
      return name === 'sh' ? '/bin/sh' : null;
    };
    unresolvedInPath('/a/calculado', [], which);
    expect(seen).toEqual(['/a/calculado']);
  });
});

describe('renderPlist', () => {
  const spec = {
    label: 'cat.start.pipelines.demo',
    programArguments: ['/bun', '/cli.ts', '--repo', '/repo', 'run', 'demo'],
    environmentVariables: { PATH: '/usr/bin', HOME: '/Users/x' },
    calendarIntervals: [{ Minute: 0, Hour: 3 }],
    logPath: '/Users/x/Library/Logs/pipelines-demo.log',
    sourcePipelineYaml: '/repo/pipelines/demo/pipeline.yaml',
    generatedAt: '2026-08-29T10:00:00.000Z',
    runAtLoad: false,
  };

  test('lleva la etiqueta, los argumentos y el horario', () => {
    const xml = renderPlist(spec);
    expect(xml).toContain('<string>cat.start.pipelines.demo</string>');
    expect(xml).toContain('<string>--repo</string>');
    expect(xml).toContain('<key>Hour</key>');
    expect(xml).toContain('<integer>3</integer>');
  });

  test('RunAtLoad va a true cuando el spec lo pide', () => {
    expect(renderPlist({ ...spec, runAtLoad: true })).toContain(
      '<key>RunAtLoad</key>\n\t<true/>',
    );
  });

  test('RunAtLoad va a false cuando el spec no lo pide', () => {
    expect(renderPlist({ ...spec, runAtLoad: false })).toContain(
      '<key>RunAtLoad</key>\n\t<false/>',
    );
  });

  test('la cabecera dice de dónde sale y que no se edite a mano', () => {
    const xml = renderPlist(spec);
    expect(xml).toContain('/repo/pipelines/demo/pipeline.yaml');
    expect(xml).toContain('NO EDITAR A MANO');
  });

  // Regla fija: el motor fija el locale por su cuenta desde el
  // 2026-08-29. Declararlo aquí reabriría la puerta que ese arreglo cerró.
  test('no declara LANG ni LC_ALL', () => {
    const xml = renderPlist(spec);
    expect(xml).not.toContain('LANG');
    expect(xml).not.toContain('LC_ALL');
  });

  test('escapa los caracteres que romperían el XML', () => {
    const xml = renderPlist({ ...spec, programArguments: ['a&b', 'c<d'] });
    expect(xml).toContain('<string>a&amp;b</string>');
    expect(xml).toContain('<string>c&lt;d</string>');
  });
});

describe('foreignJobsMentioning', () => {
  const agents = [
    { label: 'cat.start.pipelines.demo', contents: '<string>/repos/docs</string>' },
    { label: 'com.otro.backup', contents: '<string>/repos/docs</string>' },
    { label: 'com.otro.sinrelacion', contents: '<string>/otra/cosa</string>' },
  ];

  test('encuentra un job ajeno que menciona una ruta del pipeline', () => {
    expect(foreignJobsMentioning(['/repos/docs'], agents, 'cat.start.pipelines.demo')).toEqual([
      'com.otro.backup',
    ]);
  });

  // El job propio no es una colisión: mismo label significa reemplazo
  // (adopción), que es justo lo que `install` debe hacer con él.
  test('el job propio nunca cuenta como colisión', () => {
    const hits = foreignJobsMentioning(['/repos/docs'], agents, 'cat.start.pipelines.demo');
    expect(hits).not.toContain('cat.start.pipelines.demo');
  });

  test('sin coincidencias devuelve lista vacía', () => {
    expect(foreignJobsMentioning(['/nada'], agents, 'cat.start.pipelines.demo')).toEqual([]);
  });
});

describe('parseDisabledLabels', () => {
  test('devuelve solo los deshabilitados', () => {
    const out = [
      'disabled services = {',
      '\t"com.example.viejo" => disabled',
      '\t"cat.start.pipelines.demo" => enabled',
      '}',
    ].join('\n');
    expect(parseDisabledLabels(out)).toEqual(['com.example.viejo']);
  });

  test('una salida vacía no es un error, es una lista vacía', () => {
    expect(parseDisabledLabels('')).toEqual([]);
  });
});

describe('stripGeneratedAt', () => {
  // Sin esto, `drifted` sería un falso positivo permanente: el plist de disco
  // y el recién generado difieren SIEMPRE en la marca de tiempo.
  test('dos plists iguales salvo la marca de tiempo quedan idénticos', () => {
    const a = 'x\n  Generado:  2026-08-29T10:00:00.000Z\ny';
    const b = 'x\n  Generado:  2026-08-30T03:00:00.000Z\ny';
    expect(stripGeneratedAt(a)).toBe(stripGeneratedAt(b));
  });

  test('una diferencia real sobrevive', () => {
    const a = 'Generado:  2026-08-29T10:00:00.000Z\n<string>0 3 * * *</string>';
    const b = 'Generado:  2026-08-29T10:00:00.000Z\n<string>0 5 * * *</string>';
    expect(stripGeneratedAt(a)).not.toBe(stripGeneratedAt(b));
  });
});

describe('buildPlistSpec', () => {
  const input = {
    pipelineName: 'demo',
    repoRoot: '/repo',
    bunPath: '/opt/bun/bin/bun',
    cliEntry: '/motor/src/cli/index.ts',
    home: '/home/usuario',
    path: '/opt/bun/bin:/usr/bin:/bin',
    calendarIntervals: [{ Minute: 0, Hour: 3 }],
    generatedAt: '2026-08-29T10:00:00.000Z',
    guards: [],
  };

  test('los argumentos son bun run <cli> --repo <raíz> run <nombre>', () => {
    expect(buildPlistSpec(input).programArguments).toEqual([
      '/opt/bun/bin/bun', 'run', '/motor/src/cli/index.ts',
      '--repo', '/repo', 'run', 'demo',
    ]);
  });

  // El plist es un artefacto derivado y tonto. Un parámetro aquí reabriría
  // la desviación YAML/plist que `install` existe para cerrar.
  test('no lleva ningún parámetro del pipeline', () => {
    expect(buildPlistSpec(input).programArguments).not.toContain('--set');
  });

  test('solo declara PATH y HOME — LANG/LC_ALL los fija el motor', () => {
    expect(buildPlistSpec(input).environmentVariables).toEqual({
      PATH: '/opt/bun/bin:/usr/bin:/bin',
      HOME: '/home/usuario',
    });
  });

  test('el origen apunta al pipeline.yaml del repo de datos', () => {
    expect(buildPlistSpec(input).sourcePipelineYaml).toBe('/repo/pipelines/demo/pipeline.yaml');
  });

  // El lunes 2026-08-31 el informe semanal no disparó: la máquina reinició a las
  // 06:31, el dominio gui/$UID no se cargó hasta el login, y launchd NO repite
  // los StartCalendarInterval que caen mientras el dominio no está cargado.
  // `RunAtLoad` recupera ese disparo perdido — pero solo es seguro si una
  // guarda `throttle` puede saltarlo cuando la ventana no ha vencido, así que
  // se concede EXACTAMENTE a los pipelines que la declaran.
  test('sin guardas no lleva RunAtLoad: correría en cada login', () => {
    expect(buildPlistSpec(input).runAtLoad).toBe(false);
  });

  test('una guarda throttle concede RunAtLoad', () => {
    expect(buildPlistSpec({ ...input, guards: [{ throttle: '46h' }] }).runAtLoad).toBe(true);
  });

  // La forma larga es la misma guarda. Un run saltado no cuenta como intento
  // (RunStore.lastAttempt), así que tampoco con `last_attempt` un
  // disparo de login saltado empuja el ancla de la ventana.
  test('la forma larga de throttle también la concede', () => {
    const guards = [{ throttle: { every: '46h', since: 'last_attempt' as const } }];
    expect(buildPlistSpec({ ...input, guards }).runAtLoad).toBe(true);
  });

  test('una guarda que no es throttle no la concede', () => {
    const guards = [{ shell: 'test -f /tmp/x' }];
    expect(buildPlistSpec({ ...input, guards }).runAtLoad).toBe(false);
  });
});

describe('logPathFor', () => {
  test('el log vive en Library/Logs con el nombre del pipeline', () => {
    expect(logPathFor('/home/usuario', 'demo')).toBe('/home/usuario/Library/Logs/pipelines-demo.log');
  });
});

// El relevo de un pipeline real pasó sin que el motor dijera
// nada: `foreignJobsMentioning` compara RUTAS, y desde que cada pipeline tiene
// espacio propio ya no hay ninguna en común con el script de bash al que
// releva. La colisión de una migración es SEMÁNTICA —mismo trabajo, mismo
// correo, mismas personas— y hace falta una red distinta para verla.
describe('jobsNamedAfter', () => {
  const agents = [
    { label: 'com.example.nightly-checks', contents: '' },
    { label: 'cat.start.pipelines.nightly-checks', contents: '' },
    { label: 'com.example.legacy-nightly', contents: '' },
  ];

  test('encuentra el predecesor de bash con otro prefijo', () => {
    expect(jobsNamedAfter('nightly-checks', agents, 'cat.start.pipelines.nightly-checks', []))
      .toEqual(['com.example.nightly-checks']);
  });

  // El plist del predecesor se deja EN DISCO a propósito, como vía de vuelta,
  // y `readLaunchAgents` lee ficheros y no jobs cargados. Sin esta exclusión el
  // aviso saltaría en cada reinstalación posterior al relevo, para siempre —
  // el ruido que enseña a ignorar los avisos. Un job deshabilitado no puede
  // correr, así que no duplica nada.
  test('calla sobre un predecesor ya deshabilitado, que es el relevo bien hecho', () => {
    expect(jobsNamedAfter('nightly-checks', agents, 'cat.start.pipelines.nightly-checks',
      ['com.example.nightly-checks'])).toEqual([]);
  });

  test('no se señala a sí mismo', () => {
    expect(jobsNamedAfter('nightly-checks', agents, 'cat.start.pipelines.nightly-checks', []))
      .not.toContain('cat.start.pipelines.nightly-checks');
  });

  test('ignora los jobs que no llevan ese nombre', () => {
    expect(jobsNamedAfter('nightly-checks', agents, 'cat.start.pipelines.nightly-checks', []))
      .not.toContain('com.example.legacy-nightly');
  });

  // `endsWith` a secas casaría `com.example.otro-nightly-checks`, que es un job
  // DISTINTO con un nombre que acaba igual. El límite tiene que ser un punto
  // de la etiqueta, que es como launchd separa sus segmentos.
  test('exige que el nombre empiece en un límite de la etiqueta', () => {
    const trampa = [{ label: 'com.example.otro-nightly-checks', contents: '' }];
    expect(jobsNamedAfter('nightly-checks', trampa, 'x', [])).toEqual([]);
  });

  test('sin ningún job homónimo no informa de nada', () => {
    expect(jobsNamedAfter('weekly-report', agents, 'x', [])).toEqual([]);
  });
});
