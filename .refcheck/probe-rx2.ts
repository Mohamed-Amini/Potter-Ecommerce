import { TestScheduler } from 'rxjs/testing';
import { defer, NEVER, timeout, retry, timer, catchError, of, Observable } from 'rxjs';
const s = new TestScheduler(() => {});
s.run(() => {
  const times: number[] = [];
  const src: Observable<never> = defer(() => { times.push(s.now()); return NEVER; });
  src.pipe(
    timeout(10_000),
    retry({ count: 5, delay: (_e, n) => timer(200 * 2 ** (n - 1)) }),
    catchError(() => of('gave up')),
  ).subscribe((v) => console.log('BEFORE-retry settled:', v, 'at', s.now(), '| attempts at', times.join(',')));
});
const s2 = new TestScheduler(() => {});
s2.run(() => {
  const times: number[] = [];
  const src: Observable<never> = defer(() => { times.push(s2.now()); return NEVER; });
  src.pipe(
    retry({ count: 5, delay: (_e, n) => timer(200 * 2 ** (n - 1)) }),
    timeout(10_000),
    catchError(() => of('gave up')),
  ).subscribe((v) => console.log('AFTER-retry  settled:', v, 'at', s2.now(), '| attempts at', times.join(',')));
});
