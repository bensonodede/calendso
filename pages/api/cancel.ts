import prisma from "@lib/prisma";
import { CalendarEvent, deleteEvent } from "@lib/calendarClient";
import { deleteMeeting } from "@lib/videoClient";
import async from "async";
import { BookingStatus } from "@prisma/client";
import { asStringOrNull } from "@lib/asStringOrNull";
import sendPayload from "@lib/webhooks/sendPayload";
import getSubscriberUrls from "@lib/webhooks/subscriberUrls";

export default async function handler(req, res) {
  // just bail if it not a DELETE
  if (req.method !== "DELETE" && req.method !== "POST") {
    return res.status(405).end();
  }

  const uid = asStringOrNull(req.body.uid) || "";

  const bookingToDelete = await prisma.booking.findUnique({
    where: {
      uid,
    },
    select: {
      id: true,
      userId: true,
      title: true,
      startTime: true,
      endTime: true,
      description: true,
      user: {
        select: {
          credentials: true,
        },
      },
      attendees: true,
      references: {
        select: {
          uid: true,
          type: true,
        },
      },
      eventTypeId: true,
    },
  });

  if (!bookingToDelete) {
    return res.status(404).end();
  }

  // const webhookEventTypes = await prisma.webhookEventTypes.findMany({
  //   where: {
  //     eventTypeId: parseInt(bookingToDelete.eventTypeId),
  //   },
  // });

  // update organizer with proper organizer data like name, emailID, timeZone
  const organizer = await prisma.user.findFirst({
    where: {
      id: bookingToDelete.userId as number,
    },
    select: {
      name: true,
      email: true,
      timeZone: true,
    },
  });

  // update type with proper event Type (event title fetched from eventType model)

  const evt: CalendarEvent = {
    type: bookingToDelete?.title,
    title: bookingToDelete?.title,
    description: bookingToDelete?.description || "",
    startTime: bookingToDelete?.startTime.toString(),
    endTime: bookingToDelete?.endTime.toString(),
    organizer: organizer,
    attendees: bookingToDelete?.attendees.map((attendee) => {
      const retObj = { name: attendee.name, email: attendee.email, timeZone: attendee.timeZone };
      return retObj;
    }),
  };

  // Hook up the webhook logic here
  const eventTrigger = "BOOKING_CANCELLED";
  // Send Webhook call if hooked to BOOKING.CANCELLED
  const subscriberUrls = await getSubscriberUrls(
    bookingToDelete.userId,
    bookingToDelete.eventTypeId,
    eventTrigger
  );

  subscriberUrls.forEach((subscriberUrl: string) => {
    sendPayload(eventTrigger, new Date().toISOString(), subscriberUrl, evt);
  });

  // by cancelling first, and blocking whilst doing so; we can ensure a cancel
  // action always succeeds even if subsequent integrations fail cancellation.
  await prisma.booking.update({
    where: {
      uid,
    },
    data: {
      status: BookingStatus.CANCELLED,
    },
  });

  const apiDeletes = async.mapLimit(bookingToDelete.user.credentials, 5, async (credential) => {
    const bookingRefUid = bookingToDelete.references.filter((ref) => ref.type === credential.type)[0]?.uid;
    if (bookingRefUid) {
      if (credential.type.endsWith("_calendar")) {
        return await deleteEvent(credential, bookingRefUid);
      } else if (credential.type.endsWith("_video")) {
        return await deleteMeeting(credential, bookingRefUid);
      }
    }
  });

  const attendeeDeletes = prisma.attendee.deleteMany({
    where: {
      bookingId: bookingToDelete.id,
    },
  });

  const bookingReferenceDeletes = prisma.bookingReference.deleteMany({
    where: {
      bookingId: bookingToDelete.id,
    },
  });

  await Promise.all([apiDeletes, attendeeDeletes, bookingReferenceDeletes]);

  //TODO Perhaps send emails to user and client to tell about the cancellation

  res.status(204).end();
}
