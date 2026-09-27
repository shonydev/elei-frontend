import maplibregl from 'maplibre-gl';
import { EleiCafeMarker } from '../components/cafe-marker';
import type { Cafe } from '../types';

export type DeleteCafeHandler = (id: string) => Promise<boolean>;

/**
 * Adapta el modelo de cafeterías a los marcadores y popups de MapLibre.
 * No decide cómo persistir ni cómo mostrar errores: eso lo resuelve quien lo usa.
 */
export class CafeMapView {
  private readonly markers = new Map<string, maplibregl.Marker>();

  constructor(private readonly map: maplibregl.Map) {}

  showCafe(cafe: Cafe, canDelete: boolean, onDelete: DeleteCafeHandler): void {
    // Evita duplicar el marcador si la misma cafetería se renderiza más de una vez.
    this.removeCafe(cafe.id);

    const element = new EleiCafeMarker();
    element.cafe = cafe;

    const popup = new maplibregl.Popup({ offset: [0, -60], closeButton: false }).setDOMContent(
      element.createPopupContent(canDelete)
    );
    const marker = new maplibregl.Marker({ element, anchor: 'bottom' })
      .setLngLat([cafe.lng, cafe.lat])
      .setPopup(popup)
      .addTo(this.map);

    element.addEventListener('elei-cafe-delete', async (event) => {
      const { id } = (event as CustomEvent<{ id: string }>).detail;
      if (await onDelete(id)) this.removeCafe(id);
    });

    this.markers.set(cafe.id, marker);
  }

  removeCafe(id: string): void {
    this.markers.get(id)?.remove();
    this.markers.delete(id);
  }

  clear(): void {
    this.markers.forEach((marker) => marker.remove());
    this.markers.clear();
  }
}
