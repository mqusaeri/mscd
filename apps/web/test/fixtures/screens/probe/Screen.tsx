// Body of the probe screen: one card of the UI kit.
import type { ScreenProps } from '../types';
import { Card } from '../ui';

export default function ProbeScreen({ ctx }: ScreenProps) {
  return <Card title={['Probe screen', 'Layar uji']}>{ctx.li(['The screen host works.', 'Host layar berfungsi.'])}</Card>;
}
