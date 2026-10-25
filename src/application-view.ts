import { PlatformSchemas, ServiceSchemas } from '@treeseed-cordis/sdk';
export class ApiApplicationView {
    static project(value: unknown): ReturnType<typeof PlatformSchemas.application.parse> {
        const record = ServiceSchemas.applicationRecord.or(PlatformSchemas.application).parse(value);
        return PlatformSchemas.application.parse({ id: record.id, phase: record.phase, desiredComposition: record.desiredComposition, activeComposition: record.activeComposition, result: record.result, recovery: record.recovery, historyReference: record.historyReference });
    }
}
