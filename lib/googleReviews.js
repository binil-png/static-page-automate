function extractUrls(value) {
  return [...String(value || "").matchAll(/https?:\/\/[^\s,"'<>]+/gi)].map((match) => match[0]);
}

function mapsApiKey() {
  return String(process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY || "").trim();
}

function emptyReviews(mapsUrl = "", warning = "") {
  return {
    reviews: [],
    rating: null,
    total: 0,
    placeName: "",
    mapsUrl,
    warning
  };
}

function normalizeReview(review) {
  const text = String(review.text || "").replace(/\s+/g, " ").trim();
  const author = String(review.author || "").trim();
  const rating = Math.max(1, Math.min(5, Number(review.rating) || 5));
  if (!text || !author) {
    return null;
  }
  return {
    author,
    rating,
    text,
    relativeTime: String(review.relativeTime || "").trim(),
    profilePhoto: String(review.profilePhoto || "").trim()
  };
}

function uniqueReviews(reviews) {
  const seen = new Set();
  const result = [];
  for (const review of reviews) {
    const normalized = normalizeReview(review);
    if (!normalized) {
      continue;
    }
    const key = `${normalized.author}:${normalized.text.slice(0, 80)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result.slice(0, 8);
}

async function resolveMapsUrl(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  return {
    url: response.url || url,
    html: await response.text()
  };
}

function extractMapsRefs(url) {
  let decoded = String(url || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the raw URL when it is not URI-encoded.
  }

  const placeId = decoded.match(/place_id[=:]([A-Za-z0-9_-]+)/i)?.[1]
    || decoded.match(/\b(ChIJ[A-Za-z0-9_-]{10,})\b/)?.[1]
    || "";
  const cidHex = decoded.match(/!1s0x[0-9a-f]+:(0x[0-9a-f]+)/i)?.[1];
  let cid = decoded.match(/[?&]cid=(\d+)/i)?.[1] || "";
  if (!cid && cidHex) {
    try {
      cid = BigInt(cidHex).toString();
    } catch {
      cid = "";
    }
  }
  const coord = decoded.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  const query = decoded.match(/\/maps\/place\/([^/@]+)/)?.[1]?.replace(/\+/g, " ") || "";

  return {
    placeId,
    cid,
    lat: coord?.[1] || "",
    lng: coord?.[2] || "",
    query: query.replace(/-/g, " ").trim()
  };
}

async function placesGet(pathname, params) {
  const search = new URLSearchParams({ ...params, key: mapsApiKey() });
  const response = await fetch(`https://maps.googleapis.com/maps/api/place/${pathname}/json?${search}`);
  const data = await response.json();
  if (data.status && data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(data.error_message || `Places API ${data.status}`);
  }
  return data;
}

function reviewsFromPlaceDetails(details, mapsUrl) {
  const reviews = uniqueReviews((details.reviews || []).map((review) => ({
    author: review.author_name,
    rating: review.rating,
    text: review.text,
    relativeTime: review.relative_time_description,
    profilePhoto: review.profile_photo_url
  })));

  return {
    reviews,
    rating: Number(details.rating) || null,
    total: Number(details.user_ratings_total) || reviews.length,
    placeName: details.name || "",
    mapsUrl: details.url || mapsUrl,
    warning: reviews.length ? "" : "Google Maps returned this place but no public reviews."
  };
}

async function findPlaceId(refs, clinic) {
  if (refs.placeId) {
    return refs.placeId;
  }

  const input = [refs.query, clinic.clinicName, clinic.address].filter(Boolean).join(" ").trim();
  if (!input) {
    return "";
  }

  const params = {
    input,
    inputtype: "textquery",
    fields: "place_id,name"
  };
  if (refs.lat && refs.lng) {
    params.locationbias = `point:${refs.lat},${refs.lng}`;
  }

  const data = await placesGet("findplacefromtext", params);
  return data.candidates?.[0]?.place_id || "";
}

async function fetchViaPlacesApi(refs, clinic, mapsUrl) {
  const placeId = await findPlaceId(refs, clinic);
  const detailsParams = {
    fields: "name,rating,user_ratings_total,reviews,url"
  };
  if (placeId) {
    detailsParams.place_id = placeId;
  } else if (refs.cid) {
    detailsParams.cid = refs.cid;
  } else {
    throw new Error("Could not resolve a Google Place ID from the Maps location link.");
  }

  const details = await placesGet("details", detailsParams);
  if (!details.result) {
    return emptyReviews(mapsUrl, "No Google Place details were found for this Maps link.");
  }
  return reviewsFromPlaceDetails(details.result, mapsUrl);
}

function reviewsFromJsonLd(html) {
  const reviews = [];
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1]);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        const list = node.review || node.reviews || [];
        for (const review of Array.isArray(list) ? list : [list]) {
          reviews.push({
            author: review.author?.name || review.author,
            rating: review.reviewRating?.ratingValue || review.ratingValue,
            text: review.reviewBody || review.description,
            relativeTime: review.datePublished || ""
          });
        }
      }
    } catch {
      // Skip invalid JSON-LD blocks.
    }
  }

  return uniqueReviews(reviews);
}

export async function fetchGoogleReviews(clinic) {
  const raw = String(clinic.mapLocation || "").trim();
  const sourceUrl = extractUrls(raw)[0] || (/maps\.google|google\.com\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(raw) ? raw : "");
  if (!sourceUrl) {
    return emptyReviews("", "");
  }

  let resolvedUrl = sourceUrl;
  let html = "";
  try {
    const resolved = await resolveMapsUrl(sourceUrl);
    resolvedUrl = resolved.url || sourceUrl;
    html = resolved.html || "";
  } catch (error) {
    console.warn(`Google Maps link resolve failed: ${error.message}`);
  }

  const refs = extractMapsRefs(resolvedUrl);
  const key = mapsApiKey();

  if (key) {
    try {
      return await fetchViaPlacesApi(refs, clinic, resolvedUrl);
    } catch (error) {
      console.warn(`Places API reviews failed: ${error.message}`);
      const scraped = reviewsFromJsonLd(html);
      if (scraped.length) {
        return {
          reviews: scraped,
          rating: null,
          total: scraped.length,
          placeName: clinic.clinicName || "",
          mapsUrl: resolvedUrl,
          warning: ""
        };
      }
      return emptyReviews(resolvedUrl, error.message);
    }
  }

  const scraped = reviewsFromJsonLd(html);
  if (scraped.length) {
    return {
      reviews: scraped,
      rating: null,
      total: scraped.length,
      placeName: clinic.clinicName || "",
      mapsUrl: resolvedUrl,
      warning: ""
    };
  }

  return emptyReviews(
    resolvedUrl,
    "Could not load Google reviews from the Maps location link. Set GOOGLE_MAPS_API_KEY with Places API enabled."
  );
}

export function formatReviewsForPrompt(reviewData) {
  if (!reviewData?.reviews?.length) {
    return "No Google Maps reviews were fetched. Do not invent testimonials.";
  }

  const header = [
    reviewData.placeName ? `Place: ${reviewData.placeName}` : "",
    reviewData.rating ? `Overall rating: ${reviewData.rating}/5` : "",
    reviewData.total ? `Total reviews: ${reviewData.total}` : "",
    reviewData.mapsUrl ? `Maps URL: ${reviewData.mapsUrl}` : ""
  ].filter(Boolean).join("\n");

  const items = reviewData.reviews.map((review, index) => (
    `${index + 1}. ${review.author} — ${review.rating}/5${review.relativeTime ? ` — ${review.relativeTime}` : ""}\n"${review.text}"`
  )).join("\n\n");

  return `${header}\n\n${items}`;
}
