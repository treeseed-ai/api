import { ProjectTooling } from '@treeseed-cordis/sdk/source-policy';
import { UiSourcePolicy } from '@treeseed-cordis/ui/source-policy';
class ApiTooling { static run(): void { new UiSourcePolicy().check(); ProjectTooling.run(); } }
ApiTooling.run();
