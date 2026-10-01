import * as Location from 'expo-location';

export interface CapturedCoords {
  lat: number;
  lng: number;
  accuracy_m: number | null;
}

export async function getCurrentCoords(): Promise<CapturedCoords> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== 'granted') {
    throw new Error('Location permission is required to capture GPS.');
  }
  const position = await Location.getCurrentPositionAsync({
    accuracy: Location.LocationAccuracy.Balanced,
  });
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy_m: position.coords.accuracy ?? null,
  };
}
