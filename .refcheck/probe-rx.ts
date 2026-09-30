import { TestScheduler } from 'rxjs/testing';
import { defer, NEVER, timeout, retry, timer, catchError, of, shareReplay, Observable } from 'rxjs';
const run = (label: string, build: (src: Observable<never>) => Observable<unknown>) => {
  const s = new TestScheduler(() => {});
  s.run(({ flush }) => {
    let attempts = 0; let at = -1; let what = '';
    const src = defer(() => { attempts++; return NEVER; }); // an attempt that hangs forever
    build(src).subscribe({ next: (v) => { what = 'value ' + String(v); at = s.now(); }, error: (e: Error) => { what = 'error ' + e.name; at = s.now(); } });
    flush();
    console.log(label.padEnd(28), 'attempts:', attempts, '| settled at virtual ms', at, '|', what);
  });
};
const backoff = (n: number) => timer(200 * 2 ** (n - 1));
run('timeout AFTER retry (old)', (src) => src.pipe(retry({ count: 5, delay: backoff }), timeout(10_000), catchError(() => of(null))));
run('timeout BEFORE retry (new)', (src) => src.pipe(timeout(10_000), retry({ count: 5, delay: backoff }), catchError(() => of(null))));
// caching: calling a pipeline-building function twice vs sharing one observable
let requests = 0;
const fakeGet = () => defer(() => { requests++; return of([1, 2]); });
const cachedFn = () => fakeGet().pipe(shareReplay({ bufferSize: 1, refCount: true }));
cachedFn().subscribe(); cachedFn().subscribe();
console.log('function returning shareReplay pipeline, 2 callers -> requests:', requests);
requests = 0; const shared = fakeGet().pipe(shareReplay({ bufferSize: 1, refCount: false }));
shared.subscribe(); shared.subscribe();
console.log('one stored shareReplay observable, 2 callers  -> requests:', requests);
