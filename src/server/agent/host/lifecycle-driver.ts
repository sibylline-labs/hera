import type { Lifecycle } from "agents/lifecycle"
import type { AlarmDriver } from "../../durable-object/alarm-driver.js"

/** The one Lifecycle host job Hera's composite pass runs as. */
export const HERA_COMPOSITE_JOB = "hera:composite"

/**
 * An `AlarmDriver` over a Lifecycle host job: Lifecycle owns the platform alarm, and Hera owns one
 * job whose dispatch runs `runCompositePass()`. The shape `test/workerd/lifecycle-host-job.test.ts`
 * proved on workerd. `lifecycle` is read on each call, so the driver never forces a lazy install.
 */
export class LifecycleAlarmDriver implements AlarmDriver {
  constructor(private readonly lifecycle: () => Lifecycle) {}

  readonly set = async (atMs: number): Promise<void> => {
    await this.lifecycle().jobs.push({ id: HERA_COMPOSITE_JOB, fn: HERA_COMPOSITE_JOB, time: atMs })
  }

  readonly get = async (): Promise<number | null> => this.lifecycle().jobs.get(HERA_COMPOSITE_JOB)?.time ?? null

  readonly clear = async (): Promise<void> => {
    await this.lifecycle().jobs.cancel(HERA_COMPOSITE_JOB)
  }
}
